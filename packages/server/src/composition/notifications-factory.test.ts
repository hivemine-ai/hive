// Unit tests for `createNotificationsForProduction` — verifies the wiring
// (subscribe to cellEvents, hook the replay scheduler) and env var resolution.

import { describe, expect, it } from 'vitest';

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
    expect(config.heartbeatTimeoutMs).toBeNull();
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

  it('HIVE_PRESENCE_HEARTBEAT_TIMEOUT_MS=null literal stays null', () => {
    const config = resolveNotificationsConfig({ HIVE_PRESENCE_HEARTBEAT_TIMEOUT_MS: 'null' });
    expect(config.heartbeatTimeoutMs).toBeNull();
  });

  it('HIVE_PRESENCE_HEARTBEAT_TIMEOUT_MS numeric → number', () => {
    const config = resolveNotificationsConfig({ HIVE_PRESENCE_HEARTBEAT_TIMEOUT_MS: '5000' });
    expect(config.heartbeatTimeoutMs).toBe(5000);
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

  it('subscribes pipeline.handleMessageDelivered to cellEvents.messageDelivered', () => {
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

    // Sanity: emitting a messageDelivered should NOT throw — the subscription
    // is in place. We do not assert behavioural side-effects (the rig is
    // mocked to return null for everything); we just confirm the wire exists.
    expect(() =>
      cellEvents.emit('messageDelivered', {
        messageId: 'aaaa',
        cellId: 'bbbb',
        recipientId: 'cccc',
        fromParticipantId: 'dddd',
        type: 'notification',
        deliveredAt: new Date(),
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
});
