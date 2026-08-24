import {
  BadRequestException,
  ConflictException,
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createLogger } from '../../common/services/logger.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { EngineStatus, IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { HookManager } from '../../core/hooks';
import { Session, SessionStatus } from './entities/session.entity';
import { SessionEngineLifecycle } from './session-engine-lifecycle.service';
import { SessionOwnershipService } from './session-ownership.service';

/** Per-session hibernation overrides, read out of the opaque `config` column. */
interface HibernationConfig {
  /** Never hibernate this session, however idle it gets. */
  keepAlive?: boolean;
  /** Per-session override of the global idle window, in milliseconds. */
  idleTimeoutMs?: number;
}

const DEFAULT_IDLE_TIMEOUT_MS = 5_400_000;
const DEFAULT_CHECK_INTERVAL_MS = 300_000;
const DEFAULT_WAKE_TIMEOUT_MS = 45_000;
/** Poll step of the wait-for-READY loop behind a transparent wake. */
const WAKE_POLL_INTERVAL_MS = 250;

/**
 * Idle-session hibernation (Unisoft).
 *
 * A linked session that nobody messages still holds a full Chromium — several hundred MB of RAM
 * per session — for as long as it stays READY. Hibernation retires that engine after a configurable
 * idle window and reloads it on demand. The on-disk auth data is untouched, so a resume reconnects
 * without a new QR scan: the cost of hibernating is the reconnect latency, not a re-pairing.
 *
 * Split out of SessionService rather than added to it, following the upstream decomposition: this
 * is a self-contained supervisor (one timer, one idle rule) plus the two verbs the send path needs.
 * The send path injects THIS service instead of the whole lifecycle owner, the same way it injects
 * EngineRegistry rather than SessionService for engine lookups.
 *
 * Off unless SESSION_HIBERNATION_ENABLED=true; with it unset nothing here runs but the pass-through
 * in {@link ensureEngineReady}, which then behaves exactly like the plain registry lookup it
 * replaced.
 */
@Injectable()
export class SessionHibernationService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = createLogger('SessionHibernation');

  /** The periodic idle sweep; null while hibernation is disabled or after shutdown. */
  private idleCheckTimer: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(Session, 'data')
    private readonly sessionRepository: Repository<Session>,
    private readonly engines: EngineRegistry,
    private readonly engineLifecycle: SessionEngineLifecycle,
    private readonly hookManager: HookManager,
    @Optional()
    private readonly configService?: ConfigService,
    // Trailing @Optional like everywhere else in this module: the running app always provides it,
    // the direct-construction unit tests omit it, and a session then behaves as unowned — which is
    // what a single-process deployment is anyway.
    @Optional()
    private readonly ownership?: SessionOwnershipService,
  ) {}

  onApplicationBootstrap(): void {
    this.startIdleChecker();
  }

  onModuleDestroy(): void {
    if (this.idleCheckTimer) {
      clearInterval(this.idleCheckTimer);
      this.idleCheckTimer = null;
    }
  }

  /**
   * Start the periodic idle sweep. No-op unless SESSION_HIBERNATION_ENABLED is true, so an
   * unconfigured deployment carries no timer at all.
   */
  private startIdleChecker(): void {
    if (!this.configService?.get<boolean>('session.hibernationEnabled')) return;
    if (this.idleCheckTimer) return;

    const intervalMs = this.configService?.get<number>('session.checkIntervalMs') ?? DEFAULT_CHECK_INTERVAL_MS;
    this.idleCheckTimer = setInterval(() => {
      void this.hibernateIdleSessions();
    }, intervalMs);
    // Never keep the event loop alive for the sweep alone.
    this.idleCheckTimer.unref?.();

    this.logger.log('Idle session hibernation enabled', {
      action: 'idle_checker_started',
      intervalMs,
      idleTimeoutMs: this.configService?.get<number>('session.idleTimeoutMs') ?? DEFAULT_IDLE_TIMEOUT_MS,
    });
  }

  /**
   * Hibernate every loaded engine whose session has sent nothing for longer than its idle window.
   *
   * Only loaded engines are considered — a session with no engine here either runs on a peer or is
   * already down, and neither is this node's to retire. One session's failure is logged and skipped
   * rather than aborting the sweep.
   */
  async hibernateIdleSessions(): Promise<void> {
    const defaultIdleMs = this.configService?.get<number>('session.idleTimeoutMs') ?? DEFAULT_IDLE_TIMEOUT_MS;
    const now = Date.now();

    for (const sessionId of Array.from(this.engines.keys())) {
      try {
        const session = await this.sessionRepository.findOne({ where: { id: sessionId } });
        if (!session || session.status !== SessionStatus.READY) continue;

        const config = (session.config as HibernationConfig | null) ?? {};
        if (config.keepAlive === true) continue;

        const idleThreshold = config.idleTimeoutMs ?? defaultIdleMs;
        // connectedAt as the fallback reference: a session that has never sent anything is idle
        // measured from the moment it came up, not immediately idle on a null lastSentAt.
        const reference = session.lastSentAt ?? session.connectedAt;
        if (!reference) continue;

        const idleMs = now - new Date(reference).getTime();
        if (idleMs <= idleThreshold) continue;

        this.logger.log(`Hibernating idle session: ${session.name}`, {
          sessionId,
          action: 'idle_hibernate',
          idleMs,
          idleThreshold,
        });
        await this.hibernate(sessionId);
      } catch (error: unknown) {
        this.logger.error('Error during idle check', error instanceof Error ? error.message : String(error), {
          sessionId,
          action: 'idle_check_error',
        });
      }
    }
  }

  /**
   * Retire a session's engine to free its RAM, keeping the WhatsApp auth data on disk.
   *
   * Runs through the lifecycle's own stop path — stop mark, cancelled reconnect, bounded teardown
   * with the force-destroy escalation, map reconciliation — and only substitutes the final status,
   * so a hibernating session never reports a spurious `disconnected` on its way to HIBERNATED. A
   * client watching session.status sees one transition, which is what it is: an intentional unload.
   */
  async hibernate(id: string): Promise<Session> {
    const session = await this.engineLifecycle.stop(id, SessionStatus.HIBERNATED);

    this.logger.log(`Session hibernated: ${session.name}`, {
      sessionId: id,
      action: 'hibernate',
    });

    await this.hookManager.execute(
      'session:hibernated',
      { sessionId: id },
      { sessionId: id, source: 'SessionHibernationService' },
    );

    // Nothing runs here any more, so a peer may take the session over rather than waiting for the
    // lease to lapse. Guarded on engine liveness for the same reason SessionService guards its own
    // releases: a start() that raced this hibernation owns the claim now.
    await this.releaseUnlessEngineActive(id);

    return this.findOne(id);
  }

  /**
   * Reload a hibernated (or otherwise stopped) session's engine. Idempotent: a session whose engine
   * is already loaded or launching is returned untouched.
   *
   * Reuses the persisted auth data, so no QR scan is involved. The claim is taken before the engine
   * is launched, exactly as in SessionService.start — launching first and discovering the session
   * belongs to a peer would already have opened a second connection to the account.
   */
  async wake(id: string): Promise<Session> {
    const session = await this.findOne(id);

    // Already loaded (running) or mid-launch — nothing to do.
    if (this.engines.has(id) || this.engines.initializing.has(id)) return session;

    await this.hookManager.execute(
      'session:resuming',
      { sessionId: id },
      { sessionId: id, source: 'SessionHibernationService' },
    );

    this.logger.log(`Resuming session: ${session.name}`, { sessionId: id, action: 'wake' });

    if (this.ownership && !(await this.ownership.claim(id))) {
      throw new ConflictException(`Session ${id} is running on another node`);
    }
    try {
      await this.engineLifecycle.start(id);
    } catch (error) {
      await this.releaseUnlessEngineActive(id);
      throw error;
    }

    // Give the freshly-resumed session a full idle window before the sweep can consider it again.
    await this.sessionRepository.update(id, { lastSentAt: new Date() });

    await this.hookManager.execute(
      'session:resumed',
      { sessionId: id },
      { sessionId: id, source: 'SessionHibernationService' },
    );

    return this.findOne(id);
  }

  /**
   * Resolve the engine for an outgoing operation, transparently waking a hibernated session first.
   *
   * The server-side safety net behind the client-driven wake flow: a caller that never learned
   * about hibernation still gets a usable engine instead of a 400 on a session that is merely
   * asleep. Only HIBERNATED sessions are resumed — a session that was never authenticated, or was
   * stopped by an operator, still refuses, because auto-starting those would silently undo a
   * deliberate stop.
   *
   * With hibernation disabled this is exactly the registry lookup it replaced, down to the message.
   */
  async ensureEngineReady(id: string): Promise<IWhatsAppEngine> {
    const existing = this.engines.get(id);
    if (existing) return existing;

    const session = await this.sessionRepository.findOne({ where: { id } });
    if (!session || session.status !== SessionStatus.HIBERNATED) {
      throw new BadRequestException(`Session '${id}' is not active. Start the session first.`);
    }

    await this.wake(id);

    const timeoutMs = this.configService?.get<number>('session.wakeTimeoutMs') ?? DEFAULT_WAKE_TIMEOUT_MS;
    await this.waitForReady(id, timeoutMs);

    const engine = this.engines.get(id);
    if (!engine || engine.getStatus() !== EngineStatus.READY) {
      // 503, not 500: the wake is under way and a retry in a few seconds succeeds. The caller's
      // retry policy is what turns a slow resume into a delayed send rather than a failed one.
      throw new ServiceUnavailableException(`Session '${id}' is resuming from hibernation. Please retry shortly.`);
    }
    return engine;
  }

  /** Poll until the session's engine reports READY, or the timeout elapses. */
  private async waitForReady(id: string, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.engines.get(id)?.getStatus() === EngineStatus.READY) return;
      await new Promise(resolve => setTimeout(resolve, WAKE_POLL_INTERVAL_MS));
    }
  }

  /**
   * Record outgoing activity, which is what the idle window is measured from.
   *
   * Best-effort by design: a failed bookkeeping write must never fail a send that already went out,
   * so the error is logged at debug and swallowed. The worst case is one premature hibernation,
   * which the next send transparently resumes.
   */
  async markActivity(id: string): Promise<void> {
    try {
      const now = new Date();
      await this.sessionRepository.update(id, { lastSentAt: now, lastActiveAt: now });
    } catch (error: unknown) {
      this.logger.debug('Failed to record session activity', {
        sessionId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async releaseUnlessEngineActive(id: string): Promise<void> {
    if (!this.ownership || this.engineLifecycle.isEngineActive(id)) return;
    await this.ownership.release(id);
  }

  private async findOne(id: string): Promise<Session> {
    const session = await this.sessionRepository.findOne({ where: { id } });
    if (!session) throw new BadRequestException(`Session '${id}' not found`);
    return session;
  }
}
