import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ServiceUnavailableException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, In, DataSource } from 'typeorm';
import { Session, SessionStatus } from './entities/session.entity';
import { CreateSessionDto } from './dto';
import { EngineFactory } from '../../engine/engine.factory';
import { IWhatsAppEngine, EngineStatus } from '../../engine/interfaces/whatsapp-engine.interface';
import { createLogger } from '../../common/services/logger.service';
import { EventsGateway } from '../events/events.gateway';
import { WebhookService } from '../webhook/webhook.service';
import { HookManager } from '../../core/hooks';

interface ReconnectState {
  attempts: number;
  timer: NodeJS.Timeout | null;
  maxAttempts: number;
  baseDelay: number;
}

/** Per-session overrides read from Session.config */
interface SessionRuntimeConfig {
  maxReconnectAttempts?: number;
  reconnectBaseDelay?: number;
  // Hibernation overrides
  keepAlive?: boolean; // never hibernate this session
  idleTimeoutMs?: number; // override the global idle window
}

@Injectable()
export class SessionService implements OnModuleDestroy, OnModuleInit {
  private readonly logger = createLogger('SessionService');

  // In-memory map of active engine instances
  private engines: Map<string, IWhatsAppEngine> = new Map();

  // Reconnection state per session
  private reconnectStates: Map<string, ReconnectState> = new Map();

  // Sessions being stopped/hibernated on purpose. Used to suppress the
  // engine's `disconnected` event from triggering a reconnect or overwriting
  // the intentional status (e.g. HIBERNATED).
  private intentionalStops: Set<string> = new Set();

  // Timer for the periodic idle-session check (hibernation).
  private idleCheckTimer: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(Session, 'data')
    private readonly sessionRepository: Repository<Session>,
    @InjectDataSource('data')
    private readonly dataSource: DataSource,
    private readonly engineFactory: EngineFactory,
    private readonly eventsGateway: EventsGateway,
    private readonly webhookService: WebhookService,
    private readonly hookManager: HookManager,
    private readonly configService: ConfigService,
  ) {}

  /**
   * On backend startup, reset all active session statuses to disconnected
   * because the engines are not running yet after restart
   */
  async onModuleInit(): Promise<void> {
    const activeStatuses = [
      SessionStatus.READY,
      SessionStatus.INITIALIZING,
      SessionStatus.QR_READY,
      SessionStatus.AUTHENTICATING,
    ];

    const result = await this.sessionRepository.update(
      { status: In(activeStatuses) },
      { status: SessionStatus.DISCONNECTED },
    );

    if (result.affected && result.affected > 0) {
      this.logger.log(`Reset ${result.affected} session(s) to disconnected on startup`, {
        action: 'startup_reset',
        affected: result.affected,
      });
    }

    this.startIdleChecker();
  }

  /**
   * Start the periodic idle-session checker that hibernates sessions which
   * have not sent a message within the configured idle window. No-op unless
   * SESSION_HIBERNATION_ENABLED is true.
   */
  private startIdleChecker(): void {
    if (!this.configService.get<boolean>('session.hibernationEnabled')) {
      return;
    }

    const intervalMs = this.configService.get<number>('session.checkIntervalMs') ?? 300000;
    this.idleCheckTimer = setInterval(() => {
      void this.hibernateIdleSessions();
    }, intervalMs);
    // Don't keep the event loop alive solely for this timer.
    this.idleCheckTimer.unref?.();

    this.logger.log('Idle session hibernation enabled', {
      action: 'idle_checker_started',
      intervalMs,
      idleTimeoutMs: this.configService.get<number>('session.idleTimeoutMs'),
    });
  }

  /**
   * Inspect all loaded engines and hibernate the ones that have been idle
   * (no outgoing message) for longer than their idle window.
   */
  private async hibernateIdleSessions(): Promise<void> {
    const defaultIdleMs = this.configService.get<number>('session.idleTimeoutMs') ?? 5400000;
    const now = Date.now();

    // Only loaded engines can be hibernated.
    for (const sessionId of Array.from(this.engines.keys())) {
      try {
        const session = await this.sessionRepository.findOne({ where: { id: sessionId } });
        if (!session || session.status !== SessionStatus.READY) {
          continue;
        }

        const config = (session.config as SessionRuntimeConfig | null) ?? {};
        if (config.keepAlive === true) {
          continue;
        }

        const idleThreshold = config.idleTimeoutMs ?? defaultIdleMs;
        const reference = session.lastSentAt ?? session.connectedAt;
        if (!reference) {
          continue;
        }

        const idleMs = now - new Date(reference).getTime();
        if (idleMs > idleThreshold) {
          this.logger.log(`Hibernating idle session: ${session.name}`, {
            sessionId,
            action: 'idle_hibernate',
            idleMs,
            idleThreshold,
          });
          await this.hibernate(sessionId);
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error('Error during idle check', message, {
          sessionId,
          action: 'idle_check_error',
        });
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    // Stop the idle checker
    if (this.idleCheckTimer) {
      clearInterval(this.idleCheckTimer);
      this.idleCheckTimer = null;
    }
    this.intentionalStops.clear();

    // Clean up all engines on shutdown
    for (const [sessionId, engine] of this.engines) {
      this.logger.log(`Destroying engine for session ${sessionId}`, {
        sessionId,
        action: 'shutdown',
      });
      await engine.destroy();
    }
    this.engines.clear();

    // Clear all reconnect timers
    for (const [, state] of this.reconnectStates) {
      if (state.timer) {
        clearTimeout(state.timer);
      }
    }
    this.reconnectStates.clear();
  }

  async create(dto: CreateSessionDto): Promise<Session> {
    // Check if session with same name exists
    const existing = await this.sessionRepository.findOne({
      where: { name: dto.name },
    });

    if (existing) {
      throw new ConflictException(`Session with name '${dto.name}' already exists`);
    }

    const session = this.sessionRepository.create({
      name: dto.name,
      config: dto.config || {},
      proxyUrl: dto.proxyUrl || null,
      proxyType: dto.proxyType || null,
      status: SessionStatus.CREATED,
    });

    const saved = await this.dataSource.transaction(async manager => {
      return await manager.save(session);
    });
    this.logger.log(`Session created: ${saved.name}`, {
      sessionId: saved.id,
      action: 'create',
    });

    // Execute hook after session created (outside transaction since hooks do external I/O)
    await this.hookManager.execute('session:created', saved, {
      sessionId: saved.id,
      source: 'SessionService',
    });

    return saved;
  }

  async findAll(): Promise<Session[]> {
    return this.sessionRepository.find({
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(id: string): Promise<Session> {
    const session = await this.sessionRepository.findOne({ where: { id } });
    if (!session) {
      throw new NotFoundException(`Session with id '${id}' not found`);
    }
    return session;
  }

  async findByName(name: string): Promise<Session> {
    const session = await this.sessionRepository.findOne({ where: { name } });
    if (!session) {
      throw new NotFoundException(`Session with name '${name}' not found`);
    }
    return session;
  }

  async delete(id: string): Promise<void> {
    const session = await this.findOne(id);

    // Cancel any reconnection attempts
    this.cancelReconnect(id);

    // Stop engine if running
    const engine = this.engines.get(id);
    if (engine) {
      await engine.destroy();
      this.engines.delete(id);
    }

    // Execute hook BEFORE delete so plugins can access session data
    await this.hookManager.execute(
      'session:deleted',
      {
        id: session.id,
        name: session.name,
        phone: session.phone,
        pushName: session.pushName,
      },
      {
        sessionId: id,
        source: 'SessionService',
      },
    );

    await this.dataSource.transaction(async manager => {
      await manager.remove(session);
    });
    this.logger.log(`Session deleted: ${session.name}`, {
      sessionId: id,
      action: 'delete',
    });
  }

  async start(id: string): Promise<Session> {
    const session = await this.findOne(id);

    if (this.engines.has(id)) {
      throw new BadRequestException('Session is already started');
    }

    // Execute hook before starting
    await this.hookManager.execute(
      'session:starting',
      { sessionId: id },
      {
        sessionId: id,
        source: 'SessionService',
      },
    );

    // Initialize reconnect state
    const config = (session.config as SessionRuntimeConfig | null) ?? null;
    this.reconnectStates.set(id, {
      attempts: 0,
      timer: null,
      maxAttempts: config?.maxReconnectAttempts ?? 5,
      baseDelay: config?.reconnectBaseDelay ?? 5000,
    });

    await this.initializeEngine(id, session);
    return this.findOne(id);
  }

  private async initializeEngine(id: string, session: Session): Promise<void> {
    this.logger.log(`Initializing engine for session: ${session.name}`, {
      sessionId: id,
      action: 'engine_init',
      proxyEnabled: !!session.proxyUrl,
    });

    const engine = this.engineFactory.create({
      sessionId: session.name,
      proxyUrl: session.proxyUrl || undefined,
      proxyType: session.proxyType || undefined,
    });
    this.engines.set(id, engine);

    await engine.initialize({
      onQRCode: (): void => {
        this.logger.log('QR code generated', {
          sessionId: id,
          action: 'qr_generated',
        });

        // Execute hook for QR event
        void this.hookManager.execute(
          'session:qr',
          { sessionId: id },
          {
            sessionId: id,
            source: 'Engine',
          },
        );

        void this.updateStatus(id, SessionStatus.QR_READY);
      },
      onReady: (phone: string, pushName: string): void => {
        this.logger.log(`Session ready: ${phone}`, {
          sessionId: id,
          phone,
          pushName,
          action: 'ready',
        });

        // Execute hook for ready event
        void this.hookManager.execute(
          'session:ready',
          { phone, pushName },
          {
            sessionId: id,
            source: 'Engine',
          },
        );

        // Reset reconnect attempts on successful connection
        const reconnectState = this.reconnectStates.get(id);
        if (reconnectState) {
          reconnectState.attempts = 0;
        }

        void this.sessionRepository.update(id, {
          status: SessionStatus.READY,
          phone,
          pushName,
          connectedAt: new Date(),
          lastActiveAt: new Date(),
        });
      },
      onMessage: (message): void => {
        this.logger.debug(`Message received from ${message.from}`, {
          sessionId: id,
          messageId: message.id,
          from: message.from,
          action: 'message_received',
        });
        // Update last active timestamp
        void this.sessionRepository.update(id, { lastActiveAt: new Date() });
        // Convert IncomingMessage to plain object for dispatch
        const messageData = { ...message };

        // Execute hook for message received - plugins can modify or stop processing
        void this.hookManager
          .execute('message:received', messageData, {
            sessionId: id,
            source: 'Engine',
          })
          .then(({ continue: shouldContinue, data: finalMessage }) => {
            if (!shouldContinue) {
              // Plugin stopped processing (e.g., auto-reply handled it)
              return;
            }

            // Dispatch to webhooks with potentially modified message
            void this.webhookService.dispatch(id, 'message.received', finalMessage);
            // Emit real-time event to WebSocket clients
            this.eventsGateway.emitMessage(id, finalMessage);
          });
      },
      onDisconnected: (reason: string): void => {
        // Ignore disconnects we triggered ourselves (stop/hibernate) so we
        // don't reconnect or overwrite the intentional status.
        if (this.intentionalStops.has(id)) {
          this.logger.debug('Ignoring disconnect during intentional stop/hibernate', {
            sessionId: id,
            reason,
            action: 'disconnected_ignored',
          });
          return;
        }

        this.logger.warn(`Session disconnected: ${reason}`, {
          sessionId: id,
          reason,
          action: 'disconnected',
        });

        // Execute hook for disconnected event
        void this.hookManager.execute(
          'session:disconnected',
          { reason },
          {
            sessionId: id,
            source: 'Engine',
          },
        );

        void this.updateStatus(id, SessionStatus.DISCONNECTED);

        // Attempt to reconnect
        this.scheduleReconnect(id, session);
      },
      onStateChanged: (engineState: EngineStatus): void => {
        const statusMap: Record<EngineStatus, SessionStatus> = {
          [EngineStatus.DISCONNECTED]: SessionStatus.DISCONNECTED,
          [EngineStatus.INITIALIZING]: SessionStatus.INITIALIZING,
          [EngineStatus.QR_READY]: SessionStatus.QR_READY,
          [EngineStatus.AUTHENTICATING]: SessionStatus.AUTHENTICATING,
          [EngineStatus.READY]: SessionStatus.READY,
          [EngineStatus.FAILED]: SessionStatus.FAILED,
        };
        const newStatus = statusMap[engineState];
        if (newStatus) {
          void this.updateStatus(id, newStatus);
        }
      },
    });

    await this.updateStatus(id, SessionStatus.INITIALIZING);
  }

  private scheduleReconnect(id: string, session: Session): void {
    const state = this.reconnectStates.get(id);
    if (!state) return;

    if (state.attempts >= state.maxAttempts) {
      this.logger.error(`Max reconnect attempts reached for session: ${session.name}`, undefined, {
        sessionId: id,
        attempts: state.attempts,
        action: 'reconnect_failed',
      });
      return;
    }

    // Exponential backoff: baseDelay * 2^attempts (with jitter)
    const delay = state.baseDelay * Math.pow(2, state.attempts) + Math.random() * 1000;
    state.attempts++;

    this.logger.log(
      `Scheduling reconnect attempt ${state.attempts}/${state.maxAttempts} in ${Math.round(delay / 1000)}s`,
      {
        sessionId: id,
        attempt: state.attempts,
        delayMs: delay,
        action: 'reconnect_scheduled',
      },
    );

    state.timer = setTimeout(() => {
      void this.executeReconnect(id, session, state);
    }, delay);
  }

  private async executeReconnect(id: string, session: Session, state: ReconnectState): Promise<void> {
    try {
      // Clean up old engine
      const oldEngine = this.engines.get(id);
      if (oldEngine) {
        await oldEngine.destroy();
        this.engines.delete(id);
      }

      // Re-initialize
      await this.initializeEngine(id, session);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Reconnect attempt ${state.attempts} failed`, errorMessage, {
        sessionId: id,
        action: 'reconnect_error',
      });
      // Schedule another attempt
      this.scheduleReconnect(id, session);
    }
  }

  private cancelReconnect(id: string): void {
    const state = this.reconnectStates.get(id);
    if (state?.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    this.reconnectStates.delete(id);
  }

  async stop(id: string): Promise<Session> {
    const session = await this.findOne(id);

    // Cancel any reconnection attempts
    this.cancelReconnect(id);

    const engine = this.engines.get(id);

    if (engine) {
      this.intentionalStops.add(id);
      try {
        await engine.disconnect();
      } finally {
        this.intentionalStops.delete(id);
      }
      this.engines.delete(id);
    }

    this.logger.log(`Session stopped: ${session.name}`, {
      sessionId: id,
      action: 'stop',
    });
    await this.updateStatus(id, SessionStatus.DISCONNECTED);
    return this.findOne(id);
  }

  /**
   * Hibernate a session: destroy its engine (frees the Chromium instance and
   * its RAM) but keep the WhatsApp auth data on disk. The session can later be
   * resumed without scanning a QR code again. Status becomes HIBERNATED.
   */
  async hibernate(id: string): Promise<Session> {
    const session = await this.findOne(id);
    const engine = this.engines.get(id);

    // Cancel any reconnection attempts so hibernation isn't undone
    this.cancelReconnect(id);

    if (engine) {
      this.intentionalStops.add(id);
      try {
        await engine.destroy();
      } finally {
        this.intentionalStops.delete(id);
      }
      this.engines.delete(id);
    }

    await this.updateStatus(id, SessionStatus.HIBERNATED);

    this.logger.log(`Session hibernated: ${session.name}`, {
      sessionId: id,
      action: 'hibernate',
    });

    await this.hookManager.execute(
      'session:hibernated',
      { sessionId: id },
      { sessionId: id, source: 'SessionService' },
    );

    return this.findOne(id);
  }

  /**
   * Resume a hibernated (or otherwise stopped) session. Idempotent: if the
   * engine is already loaded this is a no-op. Reloading reuses the persisted
   * auth data, so no QR scan is required.
   */
  async wake(id: string): Promise<Session> {
    const session = await this.findOne(id);

    // Already loaded (running or starting) — nothing to do.
    if (this.engines.has(id)) {
      return session;
    }

    await this.hookManager.execute('session:resuming', { sessionId: id }, { sessionId: id, source: 'SessionService' });

    this.logger.log(`Resuming session: ${session.name}`, {
      sessionId: id,
      action: 'wake',
    });

    // Reuse the normal start path (reconnect state + engine init).
    await this.start(id);

    // Give the freshly-resumed session a grace window before it can be
    // considered idle again.
    await this.sessionRepository.update(id, { lastSentAt: new Date() });

    await this.hookManager.execute('session:resumed', { sessionId: id }, { sessionId: id, source: 'SessionService' });

    return this.findOne(id);
  }

  /**
   * Return a READY engine for a session, transparently waking it if it was
   * hibernated. This is the server-side safety net behind the client-driven
   * wake flow: callers (e.g. message sending) get a usable engine even if the
   * client forgot to wake the session first.
   *
   * Only HIBERNATED sessions are auto-resumed (their auth data is on disk).
   * Sessions that were never authenticated still throw so the client knows a
   * QR scan / explicit start is required.
   */
  async ensureEngineReady(id: string): Promise<IWhatsAppEngine> {
    const existing = this.engines.get(id);
    if (existing) {
      // Preserve prior behaviour: a loaded engine is returned as-is.
      return existing;
    }

    const session = await this.findOne(id);
    if (session.status !== SessionStatus.HIBERNATED) {
      throw new BadRequestException(`Session '${id}' is not active. Start the session first.`);
    }

    await this.wake(id);

    const timeoutMs = this.configService.get<number>('session.wakeTimeoutMs') ?? 45000;
    await this.waitForReady(id, timeoutMs);

    const engine = this.engines.get(id);
    if (!engine || engine.getStatus() !== EngineStatus.READY) {
      throw new ServiceUnavailableException(`Session '${id}' is resuming from hibernation. Please retry shortly.`);
    }
    return engine;
  }

  /** Poll until the session's engine reports READY or the timeout elapses. */
  private async waitForReady(id: string, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const engine = this.engines.get(id);
      if (engine && engine.getStatus() === EngineStatus.READY) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }

  /**
   * Record outgoing activity for idle detection. Best-effort: failures are
   * swallowed so they never break message sending.
   */
  async markActivity(id: string): Promise<void> {
    try {
      const now = new Date();
      await this.sessionRepository.update(id, { lastSentAt: now, lastActiveAt: now });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.debug('Failed to record session activity', { sessionId: id, error: message });
    }
  }

  async getQRCode(id: string): Promise<{ qrCode: string; status: SessionStatus }> {
    const session = await this.findOne(id);
    const engine = this.engines.get(id);

    if (!engine) {
      throw new BadRequestException('Session is not started. Call POST /sessions/:id/start first.');
    }

    const qrCode = engine.getQRCode();

    if (!qrCode) {
      if (session.status === SessionStatus.READY) {
        throw new BadRequestException('Session is already authenticated, no QR code needed');
      }
      throw new BadRequestException('QR code is not ready yet. Please wait...');
    }

    return {
      qrCode,
      status: session.status,
    };
  }

  getEngine(id: string): IWhatsAppEngine | undefined {
    return this.engines.get(id);
  }

  async getGroups(id: string): Promise<{ id: string; name: string }[]> {
    await this.findOne(id); // Verify session exists
    const engine = this.engines.get(id);

    if (!engine) {
      throw new BadRequestException('Session is not started');
    }

    const groups = await engine.getGroups();
    return groups.map(g => ({
      id: g.id,
      name: g.name,
    }));
  }

  private async updateStatus(id: string, status: SessionStatus): Promise<void> {
    await this.sessionRepository.update(id, { status });
    this.logger.debug(`Session status updated to ${status}`, {
      sessionId: id,
      status,
      action: 'status_update',
    });
    // Emit real-time event to connected WebSocket clients
    this.eventsGateway.emitSessionStatus(id, status);
  }

  /**
   * Get overall session statistics for multi-session monitoring
   */
  async getStats(): Promise<{
    total: number;
    active: number;
    ready: number;
    disconnected: number;
    byStatus: Record<string, number>;
    memoryUsage: { heapUsed: number; heapTotal: number; rss: number };
  }> {
    const sessions = await this.findAll();
    const byStatus: Record<string, number> = {};

    for (const session of sessions) {
      byStatus[session.status] = (byStatus[session.status] || 0) + 1;
    }

    const memory = process.memoryUsage();

    return {
      total: sessions.length,
      active: this.engines.size,
      ready: byStatus[SessionStatus.READY] || 0,
      disconnected: byStatus[SessionStatus.DISCONNECTED] || 0,
      byStatus,
      memoryUsage: {
        heapUsed: Math.round(memory.heapUsed / 1024 / 1024),
        heapTotal: Math.round(memory.heapTotal / 1024 / 1024),
        rss: Math.round(memory.rss / 1024 / 1024),
      },
    };
  }

  /**
   * Get count of currently active (running) sessions
   */
  getActiveCount(): number {
    return this.engines.size;
  }

  /**
   * Check if session is currently active (engine running)
   */
  isActive(id: string): boolean {
    return this.engines.has(id);
  }
}
