import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { EngineStatus, IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { HookManager } from '../../core/hooks';
import { Session, SessionStatus } from './entities/session.entity';
import { SessionEngineLifecycle } from './session-engine-lifecycle.service';
import { SessionHibernationService } from './session-hibernation.service';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    name: 'my-bot',
    status: SessionStatus.READY,
    phone: '6281234567890',
    pushName: null,
    config: {},
    proxyUrl: null,
    proxyType: null,
    connectedAt: new Date(Date.now() - 10 * 60_000),
    lastActiveAt: null,
    lastSentAt: null,
    nodeId: null,
    claimedAt: null,
    nodeUrl: null,
    leaseExpiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('SessionHibernationService', () => {
  let service: SessionHibernationService;
  let repository: { findOne: jest.Mock; update: jest.Mock };
  let engines: EngineRegistry;
  let lifecycle: { stop: jest.Mock; start: jest.Mock; isEngineActive: jest.Mock };
  let hookManager: { execute: jest.Mock };
  let config: Record<string, unknown>;
  let engine: { getStatus: jest.Mock };

  beforeEach(() => {
    repository = {
      findOne: jest.fn().mockResolvedValue(makeSession()),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    engines = new EngineRegistry();
    lifecycle = {
      stop: jest.fn().mockResolvedValue(makeSession({ status: SessionStatus.HIBERNATED })),
      start: jest.fn().mockResolvedValue(makeSession({ status: SessionStatus.INITIALIZING })),
      isEngineActive: jest.fn().mockReturnValue(false),
    };
    hookManager = { execute: jest.fn().mockResolvedValue({ continue: true, data: {} }) };
    config = {
      'session.hibernationEnabled': true,
      'session.idleTimeoutMs': 60_000,
      'session.checkIntervalMs': 300_000,
      'session.wakeTimeoutMs': 0,
    };
    engine = { getStatus: jest.fn().mockReturnValue(EngineStatus.READY) };

    service = new SessionHibernationService(
      repository as unknown as Repository<Session>,
      engines,
      lifecycle as unknown as SessionEngineLifecycle,
      hookManager as unknown as HookManager,
      { get: (key: string) => config[key] } as unknown as ConfigService,
    );
  });

  afterEach(() => service.onModuleDestroy());

  describe('hibernate', () => {
    it('retires the engine straight to HIBERNATED, never flashing disconnected', async () => {
      await service.hibernate('sess-1');

      expect(lifecycle.stop).toHaveBeenCalledWith('sess-1', SessionStatus.HIBERNATED);
      expect(hookManager.execute).toHaveBeenCalledWith(
        'session:hibernated',
        { sessionId: 'sess-1' },
        expect.objectContaining({ sessionId: 'sess-1' }),
      );
    });
  });

  describe('wake', () => {
    it('reloads the engine and fires the resuming/resumed hooks', async () => {
      repository.findOne.mockResolvedValue(makeSession({ status: SessionStatus.HIBERNATED }));

      await service.wake('sess-1');

      expect(lifecycle.start).toHaveBeenCalledWith('sess-1');
      expect(hookManager.execute).toHaveBeenCalledWith(
        'session:resuming',
        { sessionId: 'sess-1' },
        expect.objectContaining({ sessionId: 'sess-1' }),
      );
      expect(hookManager.execute).toHaveBeenCalledWith(
        'session:resumed',
        { sessionId: 'sess-1' },
        expect.objectContaining({ sessionId: 'sess-1' }),
      );
      // The resumed session gets a full idle window before the sweep may consider it again.
      expect(repository.update).toHaveBeenCalledWith('sess-1', { lastSentAt: expect.any(Date) as Date });
    });

    it('is a no-op when the engine is already loaded', async () => {
      engines.set('sess-1', engine as unknown as IWhatsAppEngine);

      await service.wake('sess-1');

      expect(lifecycle.start).not.toHaveBeenCalled();
      expect(hookManager.execute).not.toHaveBeenCalled();
    });

    it('is a no-op while the engine is still launching', async () => {
      engines.initializing.add('sess-1');

      await service.wake('sess-1');

      expect(lifecycle.start).not.toHaveBeenCalled();
    });
  });

  describe('ensureEngineReady', () => {
    it('returns the loaded engine untouched', async () => {
      engines.set('sess-1', engine as unknown as IWhatsAppEngine);

      await expect(service.ensureEngineReady('sess-1')).resolves.toBe(engine);
      expect(lifecycle.start).not.toHaveBeenCalled();
    });

    it('refuses a session that is merely stopped, rather than auto-starting it', async () => {
      repository.findOne.mockResolvedValue(makeSession({ status: SessionStatus.DISCONNECTED }));

      await expect(service.ensureEngineReady('sess-1')).rejects.toBeInstanceOf(BadRequestException);
      expect(lifecycle.start).not.toHaveBeenCalled();
    });

    it('wakes a hibernated session and returns its READY engine', async () => {
      repository.findOne.mockResolvedValue(makeSession({ status: SessionStatus.HIBERNATED }));
      lifecycle.start.mockImplementation(() => {
        engines.set('sess-1', engine as unknown as IWhatsAppEngine);
        return Promise.resolve(makeSession({ status: SessionStatus.READY }));
      });

      await expect(service.ensureEngineReady('sess-1')).resolves.toBe(engine);
    });

    it('answers 503 when the resume has not reached READY within the wake timeout', async () => {
      repository.findOne.mockResolvedValue(makeSession({ status: SessionStatus.HIBERNATED }));
      lifecycle.start.mockImplementation(() => {
        engine.getStatus.mockReturnValue(EngineStatus.INITIALIZING);
        engines.set('sess-1', engine as unknown as IWhatsAppEngine);
        return Promise.resolve(makeSession({ status: SessionStatus.INITIALIZING }));
      });

      await expect(service.ensureEngineReady('sess-1')).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });

  describe('markActivity', () => {
    it('stamps both activity columns', async () => {
      await service.markActivity('sess-1');

      expect(repository.update).toHaveBeenCalledWith('sess-1', {
        lastSentAt: expect.any(Date) as Date,
        lastActiveAt: expect.any(Date) as Date,
      });
    });

    it('never throws — a failed bookkeeping write must not fail the send it follows', async () => {
      repository.update.mockRejectedValue(new Error('db down'));

      await expect(service.markActivity('sess-1')).resolves.toBeUndefined();
    });
  });

  describe('idle sweep', () => {
    const idle = (ms: number) => new Date(Date.now() - ms);

    beforeEach(() => engines.set('sess-1', engine as unknown as IWhatsAppEngine));

    it('hibernates a READY session idle past the window', async () => {
      repository.findOne.mockResolvedValue(makeSession({ lastSentAt: idle(120_000) }));

      await service.hibernateIdleSessions();

      expect(lifecycle.stop).toHaveBeenCalledWith('sess-1', SessionStatus.HIBERNATED);
    });

    it('leaves a session inside its idle window alone', async () => {
      repository.findOne.mockResolvedValue(makeSession({ lastSentAt: idle(30_000) }));

      await service.hibernateIdleSessions();

      expect(lifecycle.stop).not.toHaveBeenCalled();
    });

    it('honours the per-session keepAlive override', async () => {
      repository.findOne.mockResolvedValue(makeSession({ lastSentAt: idle(120_000), config: { keepAlive: true } }));

      await service.hibernateIdleSessions();

      expect(lifecycle.stop).not.toHaveBeenCalled();
    });

    it('honours a per-session idle window longer than the global one', async () => {
      repository.findOne.mockResolvedValue(
        makeSession({ lastSentAt: idle(120_000), config: { idleTimeoutMs: 600_000 } }),
      );

      await service.hibernateIdleSessions();

      expect(lifecycle.stop).not.toHaveBeenCalled();
    });

    it('skips a session that is not READY', async () => {
      repository.findOne.mockResolvedValue(
        makeSession({ status: SessionStatus.AUTHENTICATING, lastSentAt: idle(120_000) }),
      );

      await service.hibernateIdleSessions();

      expect(lifecycle.stop).not.toHaveBeenCalled();
    });

    it('measures a session that has never sent from connectedAt', async () => {
      repository.findOne.mockResolvedValue(makeSession({ lastSentAt: null, connectedAt: idle(120_000) }));

      await service.hibernateIdleSessions();

      expect(lifecycle.stop).toHaveBeenCalledWith('sess-1', SessionStatus.HIBERNATED);
    });

    it('keeps sweeping after one session fails', async () => {
      engines.set('sess-2', engine as unknown as IWhatsAppEngine);
      repository.findOne
        .mockRejectedValueOnce(new Error('db hiccup'))
        .mockResolvedValueOnce(makeSession({ id: 'sess-2', lastSentAt: idle(120_000) }));

      await service.hibernateIdleSessions();

      expect(lifecycle.stop).toHaveBeenCalledTimes(1);
      expect(lifecycle.stop).toHaveBeenCalledWith('sess-2', SessionStatus.HIBERNATED);
    });

    it('runs no timer at all while hibernation is disabled', () => {
      config['session.hibernationEnabled'] = false;

      service.onApplicationBootstrap();

      expect((service as unknown as { idleCheckTimer: NodeJS.Timeout | null }).idleCheckTimer).toBeNull();
    });
  });
});
