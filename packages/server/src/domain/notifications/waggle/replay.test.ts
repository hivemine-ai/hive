// Unit tests for the replay path. Mocks `cellsRepo`, `participantsRepo`,
// `builder`, and `logger`.

import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ParticipantsReadRepo } from '#domain/auth/index.js';
import type { Cell, CellsRepo } from '#domain/cells/index.js';
import type { Logger } from '#observability/logger.js';

import type { SubscriberHandle } from '#domain/notifications/presence/subscriber-handle.js';
import type { WaggleNotification } from './types.js';

import { createReplay } from './replay.js';
import type { Builder } from './builder.js';

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

function activeCell(ownerId: string): Cell {
  return {
    id: uuidv7(),
    hiveId: uuidv7(),
    ownerId,
    ownerKind: 'agent',
    state: 'active',
    createdAt: new Date(),
    closedAt: null,
  };
}

function fakeHandle(): SubscriberHandle & { captured: WaggleNotification[] } {
  const captured: WaggleNotification[] = [];
  return {
    connectionId: uuidv7(),
    callerContext: {} as SubscriberHandle['callerContext'],
    captured,
    deliver(n: WaggleNotification) {
      captured.push(n);
      return Promise.resolve();
    },
    close() {},
    onClose() {},
  };
}

const OPEN_REGISTRY = { isOpen: () => true, unsubscribe: () => undefined };

function notification(cellId: string, recipientId: string): WaggleNotification {
  return {
    kind: 'replay',
    eventId: 'event',
    cellId,
    recipientId,
    unreadCount: 1,
    coalescedCount: 0,
    senderIds: [uuidv7()],
    emittedAt: new Date(),
    waggleId: uuidv7(),
  };
}

function fakeBuilder(notification: WaggleNotification | null): Builder {
  return {
    buildOnlineWaggle: () => Promise.resolve(notification),
    buildReplayWaggle: () => Promise.resolve(notification),
  };
}

describe('createReplay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runReplayFor: cell not found → no-op (no deliver)', async () => {
    const cellsRepo = {
      findCellByOwner: () => Promise.resolve(null),
    } as unknown as CellsRepo;
    const participantsRepo = {
      getParticipantState: () =>
        Promise.resolve({
          kind: 'worker',
          state: 'active' as const,
          isAdmin: null,
          hiveId: '',
          colonyId: '',
          ownerId: null,
        }),
    } as unknown as ParticipantsReadRepo;
    const handle = fakeHandle();

    const replay = createReplay(
      {
        cellsRepo,
        participantsRepo,
        builder: fakeBuilder(null),
        logger: silentLogger(),
        presenceRegistry: OPEN_REGISTRY,
      },
      { replayDelayMs: 0 },
    );

    await replay.runReplayFor(uuidv7(), handle, uuidv7());

    expect(handle.captured).toHaveLength(0);
  });

  it('runReplayFor: cell closed → no-op', async () => {
    const ownerId = uuidv7();
    const cell = activeCell(ownerId);
    cell.state = 'closed';
    cell.closedAt = new Date();
    const cellsRepo = {
      findCellByOwner: () => Promise.resolve(cell),
    } as unknown as CellsRepo;
    const participantsRepo = {
      getParticipantState: () =>
        Promise.resolve({
          kind: 'worker',
          state: 'active' as const,
          isAdmin: null,
          hiveId: '',
          colonyId: '',
          ownerId: null,
        }),
    } as unknown as ParticipantsReadRepo;
    const handle = fakeHandle();

    const replay = createReplay(
      {
        cellsRepo,
        participantsRepo,
        builder: fakeBuilder(null),
        logger: silentLogger(),
        presenceRegistry: OPEN_REGISTRY,
      },
      { replayDelayMs: 0 },
    );

    await replay.runReplayFor(ownerId, handle, uuidv7());

    expect(handle.captured).toHaveLength(0);
  });

  it('runReplayFor: state suspended → no-op', async () => {
    const ownerId = uuidv7();
    const cellsRepo = {
      findCellByOwner: () => Promise.resolve(activeCell(ownerId)),
    } as unknown as CellsRepo;
    const participantsRepo = {
      getParticipantState: () =>
        Promise.resolve({
          kind: 'worker',
          state: 'suspended' as const,
          isAdmin: null,
          hiveId: '',
          colonyId: '',
          ownerId: null,
        }),
    } as unknown as ParticipantsReadRepo;
    const handle = fakeHandle();

    const replay = createReplay(
      {
        cellsRepo,
        participantsRepo,
        builder: fakeBuilder(null),
        logger: silentLogger(),
        presenceRegistry: OPEN_REGISTRY,
      },
      { replayDelayMs: 0 },
    );

    await replay.runReplayFor(ownerId, handle, uuidv7());

    expect(handle.captured).toHaveLength(0);
  });

  it('runReplayFor: empty Cell (builder returns null) → no deliver', async () => {
    const ownerId = uuidv7();
    const cellsRepo = {
      findCellByOwner: () => Promise.resolve(activeCell(ownerId)),
    } as unknown as CellsRepo;
    const participantsRepo = {
      getParticipantState: () =>
        Promise.resolve({
          kind: 'worker',
          state: 'active' as const,
          isAdmin: null,
          hiveId: '',
          colonyId: '',
          ownerId: null,
        }),
    } as unknown as ParticipantsReadRepo;
    const handle = fakeHandle();

    const replay = createReplay(
      {
        cellsRepo,
        participantsRepo,
        builder: fakeBuilder(null),
        logger: silentLogger(),
        presenceRegistry: OPEN_REGISTRY,
      },
      { replayDelayMs: 0 },
    );

    await replay.runReplayFor(ownerId, handle, uuidv7());

    expect(handle.captured).toHaveLength(0);
  });

  it('runReplayFor: happy path → deliver invoked exactly once with kind=replay', async () => {
    const ownerId = uuidv7();
    const cell = activeCell(ownerId);
    const cellsRepo = {
      findCellByOwner: () => Promise.resolve(cell),
    } as unknown as CellsRepo;
    const participantsRepo = {
      getParticipantState: () =>
        Promise.resolve({
          kind: 'worker',
          state: 'active' as const,
          isAdmin: null,
          hiveId: '',
          colonyId: '',
          ownerId: null,
        }),
    } as unknown as ParticipantsReadRepo;
    const handle = fakeHandle();

    const notif: WaggleNotification = {
      kind: 'replay',
      eventId: 'event',
      coalescedCount: 0,
      cellId: cell.id,
      recipientId: ownerId,
      unreadCount: 3,
      senderIds: [uuidv7()],
      emittedAt: new Date(),
      waggleId: uuidv7(),
    };
    const replay = createReplay(
      {
        cellsRepo,
        participantsRepo,
        builder: fakeBuilder(notif),
        logger: silentLogger(),
        presenceRegistry: OPEN_REGISTRY,
      },
      { replayDelayMs: 0 },
    );

    await replay.runReplayFor(ownerId, handle, uuidv7());

    expect(handle.captured).toHaveLength(1);
    expect(handle.captured[0]?.kind).toBe('replay');
    expect(handle.captured[0]?.unreadCount).toBe(3);
  });

  describe('failure closes the stream', () => {
    function rig(overrides: { cellsRepo?: CellsRepo; deliver?: () => Promise<void> } = {}) {
      const ownerId = uuidv7();
      const cell = activeCell(ownerId);
      const closes: string[] = [];
      const unsubscribed: string[] = [];
      const errors: object[] = [];
      const logger = {
        ...silentLogger(),
        error: (p: object) => errors.push(p),
      } as unknown as Logger;
      const handle: SubscriberHandle = {
        connectionId: uuidv7(),
        callerContext: {} as SubscriberHandle['callerContext'],
        deliver: overrides.deliver ?? (() => Promise.resolve()),
        close(reason) {
          closes.push(reason);
        },
        onClose() {},
      };
      const replay = createReplay(
        {
          cellsRepo:
            overrides.cellsRepo ??
            ({ findCellByOwner: () => Promise.resolve(cell) } as unknown as CellsRepo),
          participantsRepo: {
            getParticipantState: () => Promise.resolve({ state: 'active' }),
          } as unknown as ParticipantsReadRepo,
          builder: fakeBuilder(notification(cell.id, ownerId)),
          presenceRegistry: {
            isOpen: () => true,
            unsubscribe: (_id: string, _participant: string, reason: string) => {
              unsubscribed.push(reason);
            },
          },
          logger,
        },
        { replayDelayMs: 0 },
      );
      return { replay, ownerId, handle, closes, unsubscribed, errors };
    }

    it('a failed deliver closes with replay_failed and logs waggle_replay_failed', async () => {
      const r = rig({ deliver: () => Promise.reject(new Error('socket dead')) });
      r.replay.scheduleReplayFor(r.ownerId, r.handle, uuidv7());
      await vi.waitFor(() => {
        expect(r.closes).toEqual(['replay_failed']);
      });
      expect(r.unsubscribed).toEqual(['replay_failed']);
      expect(r.errors[0]).toMatchObject({
        event: 'waggle_replay_failed',
        participantId: r.ownerId,
        errorClass: 'Error',
      });
    });

    it('a failed query closes the same way', async () => {
      const r = rig({
        cellsRepo: {
          findCellByOwner: () => Promise.reject(new Error('db down')),
        } as unknown as CellsRepo,
      });
      r.replay.scheduleReplayFor(r.ownerId, r.handle, uuidv7());
      await vi.waitFor(() => {
        expect(r.closes).toEqual(['replay_failed']);
      });
    });

    it('a stream no longer open gets nothing, and that is not a failure', async () => {
      const ownerId = uuidv7();
      const cell = activeCell(ownerId);
      const handle = fakeHandle();
      const replay = createReplay(
        {
          cellsRepo: { findCellByOwner: () => Promise.resolve(cell) } as unknown as CellsRepo,
          participantsRepo: {
            getParticipantState: () => Promise.resolve({ state: 'active' }),
          } as unknown as ParticipantsReadRepo,
          builder: fakeBuilder(notification(cell.id, ownerId)),
          presenceRegistry: { isOpen: () => false, unsubscribe: () => undefined },
          logger: silentLogger(),
        },
        { replayDelayMs: 0 },
      );
      await replay.runReplayFor(ownerId, handle, uuidv7());
      expect(handle.captured).toHaveLength(0);
    });
  });

  it('scheduleReplayFor: setImmediate path (replayDelayMs=0)', async () => {
    const ownerId = uuidv7();
    const cell = activeCell(ownerId);
    const cellsRepo = {
      findCellByOwner: () => Promise.resolve(cell),
    } as unknown as CellsRepo;
    const participantsRepo = {
      getParticipantState: () =>
        Promise.resolve({
          kind: 'worker',
          state: 'active' as const,
          isAdmin: null,
          hiveId: '',
          colonyId: '',
          ownerId: null,
        }),
    } as unknown as ParticipantsReadRepo;
    const handle = fakeHandle();

    const notif: WaggleNotification = {
      kind: 'replay',
      eventId: 'event',
      coalescedCount: 0,
      cellId: cell.id,
      recipientId: ownerId,
      unreadCount: 1,
      senderIds: [uuidv7()],
      emittedAt: new Date(),
      waggleId: uuidv7(),
    };
    const replay = createReplay(
      {
        cellsRepo,
        participantsRepo,
        builder: fakeBuilder(notif),
        logger: silentLogger(),
        presenceRegistry: OPEN_REGISTRY,
      },
      { replayDelayMs: 0 },
    );

    replay.scheduleReplayFor(ownerId, handle, uuidv7());

    // Drive the setImmediate via fake timers + drain microtasks.
    await vi.runAllTimersAsync();
    await Promise.resolve();
    await Promise.resolve();

    expect(handle.captured).toHaveLength(1);
  });

  it('scheduleReplayFor: setTimeout path when replayDelayMs > 0', async () => {
    const ownerId = uuidv7();
    const cell = activeCell(ownerId);
    const cellsRepo = {
      findCellByOwner: () => Promise.resolve(cell),
    } as unknown as CellsRepo;
    const participantsRepo = {
      getParticipantState: () =>
        Promise.resolve({
          kind: 'worker',
          state: 'active' as const,
          isAdmin: null,
          hiveId: '',
          colonyId: '',
          ownerId: null,
        }),
    } as unknown as ParticipantsReadRepo;
    const handle = fakeHandle();

    const notif: WaggleNotification = {
      kind: 'replay',
      eventId: 'event',
      coalescedCount: 0,
      cellId: cell.id,
      recipientId: ownerId,
      unreadCount: 1,
      senderIds: [uuidv7()],
      emittedAt: new Date(),
      waggleId: uuidv7(),
    };
    const replay = createReplay(
      {
        cellsRepo,
        participantsRepo,
        builder: fakeBuilder(notif),
        logger: silentLogger(),
        presenceRegistry: OPEN_REGISTRY,
      },
      { replayDelayMs: 25 },
    );

    replay.scheduleReplayFor(ownerId, handle, uuidv7());

    // Before the delay elapses, no deliver yet.
    await vi.advanceTimersByTimeAsync(10);
    expect(handle.captured).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();

    expect(handle.captured).toHaveLength(1);
  });
});
