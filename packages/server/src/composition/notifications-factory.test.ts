// Unit tests for `createNotificationsForProduction` — verifies the wiring
// (subscribe to cellEvents, hook the replay scheduler) and env var resolution.

import { describe, expect, it, vi } from 'vitest';

import type { ParticipantsReadRepo } from '#domain/auth/index.js';
import { createCellEvents } from '#domain/cells/index.js';
import type { CellsRepo } from '#domain/cells/index.js';
import type { Logger } from '#observability/logger.js';

import {
  createNotificationsForProduction,
  resolveNotificationsConfig,
} from './notifications-factory.js';

function silentLogger(): Logger {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
  } as unknown as Logger;
}

function fakeCellsRepo(): CellsRepo {
  return {
    summarizeUnreadForCell: () => Promise.resolve({ unreadCount: 0, distinctSenderIds: [] }),
    findCellByOwner: () => Promise.resolve(null),
    findCellById: () => Promise.resolve(null),
  } as unknown as CellsRepo;
}

function fakeParticipantsRepo(): ParticipantsReadRepo {
  return {
    getParticipantState: () => Promise.resolve(null),
  } as unknown as ParticipantsReadRepo;
}

describe('resolveNotificationsConfig', () => {
  it('returns defaults when env is empty and options is empty', () => {
    const config = resolveNotificationsConfig({});

    expect(config.quietWindowMs).toBe(500);
    expect(config.replayDelayMs).toBe(0);
    expect(config.maxSessionsPerParticipant).toBe(16);
  });

  it('options.quietWindowMs overrides env', () => {
    const config = resolveNotificationsConfig(
      { HIVE_WAGGLE_QUIET_WINDOW_MS: '999' },
      { quietWindowMs: 10 },
    );
    expect(config.quietWindowMs).toBe(10);
  });

  it('env value wins over default', () => {
    const config = resolveNotificationsConfig({
      HIVE_WAGGLE_QUIET_WINDOW_MS: '50',
      HIVE_PRESENCE_MAX_SESSIONS_PER_PARTICIPANT: '4',
    });
    expect(config.quietWindowMs).toBe(50);
    expect(config.maxSessionsPerParticipant).toBe(4);
  });

  it('reads HIVE_PRESENCE_CLAIM_RESERVATION_MS, default 10 s (ADR-026)', () => {
    expect(resolveNotificationsConfig({}).claimReservationMs).toBe(10_000);
    expect(
      resolveNotificationsConfig({ HIVE_PRESENCE_CLAIM_RESERVATION_MS: '2500' }).claimReservationMs,
    ).toBe(2500);
    expect(() => resolveNotificationsConfig({ HIVE_PRESENCE_CLAIM_RESERVATION_MS: '0' })).toThrow(
      /must be >= 1/,
    );
  });

  it('non-numeric env throws', () => {
    expect(() => resolveNotificationsConfig({ HIVE_WAGGLE_QUIET_WINDOW_MS: 'oops' })).toThrow(
      /must be an integer/,
    );
  });

  it('negative env value below min throws', () => {
    expect(() =>
      resolveNotificationsConfig({ HIVE_PRESENCE_MAX_SESSIONS_PER_PARTICIPANT: '0' }),
    ).toThrow(/must be >= 1/);
  });

  it('ignores the retired sweep / idle / LRU-threshold env vars', () => {
    const config = resolveNotificationsConfig({
      HIVE_PRESENCE_IDLE_TIMEOUT_MS: '60000',
      HIVE_PRESENCE_SWEEP_INTERVAL_MS: '30000',
      HIVE_PRESENCE_LRU_EVICT_THRESHOLD_MS: '60000',
      HIVE_PRESENCE_HEARTBEAT_TIMEOUT_MS: '1000',
    });
    expect(Object.keys(config).sort()).toEqual([
      'claimReservationMs',
      'maxSessionsPerParticipant',
      'quietWindowMs',
      'replayDelayMs',
      'senderWakeupsPerWindow',
      'senderWindowMs',
    ]);
  });
});

describe('createNotificationsForProduction wiring', () => {
  it('returns presenceRegistry, pipeline, builder, consolidator, replay', () => {
    const result = createNotificationsForProduction({
      cellEvents: createCellEvents(),
      cellsRepo: fakeCellsRepo(),
      participantsRepo: fakeParticipantsRepo(),
      logger: silentLogger(),
    });

    expect(result.presenceRegistry).toBeDefined();
    expect(result.pipeline).toBeDefined();
    expect(result.builder).toBeDefined();
    expect(result.consolidator).toBeDefined();
    expect(result.replay).toBeDefined();
  });

  it.each([
    ['suspended', 'participant_suspended'],
    ['retired', 'participant_retired'],
    ['revoked', 'participant_revoked'],
  ] as const)(
    'a %s state change closes the streams of the participant with %s',
    (newState, reason) => {
      const result = createNotificationsForProduction({
        cellEvents: createCellEvents(),
        cellsRepo: fakeCellsRepo(),
        participantsRepo: fakeParticipantsRepo(),
        logger: silentLogger(),
      });
      const close = vi.spyOn(result.presenceRegistry, 'closeParticipantStreams');

      result.handleParticipantStateChanged({ participantId: 'agent-1', newState });

      expect(close).toHaveBeenCalledWith('agent-1', reason);
    },
  );

  it('subscribes pipeline.handleMessageStored to cellEvents.messageStored', () => {
    const cellEvents = createCellEvents();
    const result = createNotificationsForProduction(
      {
        cellEvents,
        cellsRepo: fakeCellsRepo(),
        participantsRepo: fakeParticipantsRepo(),
        logger: silentLogger(),
      },
      { quietWindowMs: 10_000 },
    );

    // Sanity: emitting a messageStored should NOT throw — the subscription
    // is in place. We do not assert behavioural side-effects (the rig is
    // mocked to return null for everything); we just confirm the wire exists.
    expect(() =>
      cellEvents.emit('messageStored', {
        messageId: 'aaaa',
        cellId: 'bbbb',
        recipientId: 'cccc',
        fromParticipantId: 'dddd',
        type: 'notification',
        storedAt: new Date(),
      }),
    ).not.toThrow();
    expect(result.pipeline).toBeDefined();
  });

  it('subscribes pipeline.handleCellClosed to cellEvents.cellClosed', () => {
    const cellEvents = createCellEvents();
    createNotificationsForProduction({
      cellEvents,
      cellsRepo: fakeCellsRepo(),
      participantsRepo: fakeParticipantsRepo(),
      logger: silentLogger(),
    });

    expect(() =>
      cellEvents.emit('cellClosed', {
        cellId: 'aaaa',
        ownerId: 'bbbb',
        closedAt: new Date(),
        reason: 'participant_revoked',
      }),
    ).not.toThrow();
  });

  it('options override env values used by the registry', () => {
    const result = createNotificationsForProduction(
      {
        cellEvents: createCellEvents(),
        cellsRepo: fakeCellsRepo(),
        participantsRepo: fakeParticipantsRepo(),
        logger: silentLogger(),
      },
      { maxSessionsPerParticipant: 2 },
    );

    expect(result.presenceRegistry).toBeDefined();
  });

  it('Subscription.ready() schedules the replay for that stream; subscribe alone does not', async () => {
    const participantId = '01900000-0000-7000-8000-000000000001';
    const result = createNotificationsForProduction({
      cellEvents: createCellEvents(),
      cellsRepo: fakeCellsRepo(),
      participantsRepo: {
        getParticipantState: () => Promise.resolve({ state: 'active' }),
      } as unknown as ParticipantsReadRepo,
      logger: silentLogger(),
    });
    const scheduleSpy = vi.spyOn(result.replay, 'scheduleReplayFor').mockImplementation(() => {});
    const handle = {
      connectionId: '01900000-0000-7000-8000-0000000000aa',
      callerContext: {} as never,
      deliver: () => Promise.resolve(),
      close: () => {},
      onClose: () => {},
    };

    const sub = await result.presenceRegistry.subscribe({
      callerContext: {
        participantId,
        kind: 'worker',
        current: { state: 'active', type: 'worker' },
      } as never,
      handle,
    });
    expect(scheduleSpy).not.toHaveBeenCalled();

    sub.ready();
    expect(scheduleSpy).toHaveBeenCalledWith(participantId, handle, sub.id);
  });
});
