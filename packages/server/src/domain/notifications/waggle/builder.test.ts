// Unit tests for the Waggle builder.

import { v7 as uuidv7 } from 'uuid';
import { describe, expect, it } from 'vitest';

import type { CellsRepo } from '#domain/cells/index.js';

import { createBuilder, deriveEventId } from './builder.js';

function fakeCellsRepo(summary: {
  unreadCount: number;
  distinctSenderIds: string[];
  latestMessageId?: string | null;
}): CellsRepo {
  return {
    summarizeUnreadForCell: () => Promise.resolve({ latestMessageId: uuidv7(), ...summary }),
  } as unknown as CellsRepo;
}

describe('createBuilder', () => {
  it('buildOnlineWaggle returns null when unreadCount is 0', async () => {
    const builder = createBuilder({
      cellsRepo: fakeCellsRepo({ unreadCount: 0, distinctSenderIds: [] }),
    });

    const result = await builder.buildOnlineWaggle({
      cellId: uuidv7(),
      recipientId: uuidv7(),
      coalescedCount: 1,
    });

    expect(result).toBeNull();
  });

  it('buildOnlineWaggle returns a populated WaggleNotification when unreadCount > 0', async () => {
    const senderA = uuidv7();
    const senderB = uuidv7();
    const builder = createBuilder({
      cellsRepo: fakeCellsRepo({ unreadCount: 5, distinctSenderIds: [senderA, senderB] }),
    });
    const cellId = uuidv7();
    const recipientId = uuidv7();

    const result = await builder.buildOnlineWaggle({ cellId, recipientId, coalescedCount: 1 });

    expect(result).not.toBeNull();
    expect(result?.kind).toBe('online');
    expect(result?.cellId).toBe(cellId);
    expect(result?.recipientId).toBe(recipientId);
    expect(result?.unreadCount).toBe(5);
    expect(result?.senderIds).toEqual([senderA, senderB]);
    expect(result?.emittedAt).toBeInstanceOf(Date);
    expect(result?.waggleId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('buildReplayWaggle is symmetric to buildOnlineWaggle but with kind=replay', async () => {
    const senderA = uuidv7();
    const builder = createBuilder({
      cellsRepo: fakeCellsRepo({ unreadCount: 1, distinctSenderIds: [senderA] }),
    });

    const result = await builder.buildReplayWaggle({
      cellId: uuidv7(),
      recipientId: uuidv7(),
    });

    expect(result?.kind).toBe('replay');
    expect(result?.unreadCount).toBe(1);
  });

  it('buildReplayWaggle returns null when unreadCount is 0 (empty Cell at replay)', async () => {
    const builder = createBuilder({
      cellsRepo: fakeCellsRepo({ unreadCount: 0, distinctSenderIds: [] }),
    });

    const result = await builder.buildReplayWaggle({
      cellId: uuidv7(),
      recipientId: uuidv7(),
    });

    expect(result).toBeNull();
  });

  it('two consecutive buildOnlineWaggle calls produce distinct waggleIds (NOT a dedup primitive)', async () => {
    const builder = createBuilder({
      cellsRepo: fakeCellsRepo({ unreadCount: 1, distinctSenderIds: [uuidv7()] }),
    });
    const args = { cellId: uuidv7(), recipientId: uuidv7(), coalescedCount: 1 };

    const first = await builder.buildOnlineWaggle(args);
    const second = await builder.buildOnlineWaggle(args);

    expect(first?.waggleId).not.toBe(second?.waggleId);
  });

  describe('eventId', () => {
    const cellId = uuidv7();
    const recipientId = uuidv7();
    const latestMessageId = uuidv7();
    const build = (unreadCount: number, latest = latestMessageId) =>
      createBuilder({
        cellsRepo: fakeCellsRepo({
          unreadCount,
          distinctSenderIds: [uuidv7()],
          latestMessageId: latest,
        }),
      });

    it('is the same for an online and a replay Waggle of the same state', async () => {
      const online = await build(2).buildOnlineWaggle({ cellId, recipientId, coalescedCount: 3 });
      const replay = await build(2).buildReplayWaggle({ cellId, recipientId });
      expect(online?.eventId).toBe(replay?.eventId);
      expect(online?.waggleId).not.toBe(replay?.waggleId);
    });

    it('changes with unreadCount or latestMessageId, not with coalescedCount', async () => {
      const base = await build(2).buildOnlineWaggle({ cellId, recipientId, coalescedCount: 1 });
      const coalesced = await build(2).buildOnlineWaggle({
        cellId,
        recipientId,
        coalescedCount: 9,
      });
      const moreUnread = await build(3).buildOnlineWaggle({
        cellId,
        recipientId,
        coalescedCount: 1,
      });
      const newer = await build(2, uuidv7()).buildOnlineWaggle({
        cellId,
        recipientId,
        coalescedCount: 1,
      });
      expect(coalesced?.eventId).toBe(base?.eventId);
      expect(moreUnread?.eventId).not.toBe(base?.eventId);
      expect(newer?.eventId).not.toBe(base?.eventId);
    });

    it('is a pure function, stable across processes and short enough for clients', () => {
      const id = deriveEventId(
        '01900000-0000-7000-8000-000000000001',
        '01900000-0000-7000-8000-000000000002',
        4,
      );
      expect(id).toBe(
        deriveEventId(
          '01900000-0000-7000-8000-000000000001',
          '01900000-0000-7000-8000-000000000002',
          4,
        ),
      );
      expect(id).toMatch(/^[0-9a-f]{64}$/);
    });

    it('replay carries coalescedCount 0; online carries the admitted count', async () => {
      const online = await build(1).buildOnlineWaggle({ cellId, recipientId, coalescedCount: 4 });
      const replay = await build(1).buildReplayWaggle({ cellId, recipientId });
      expect(online?.coalescedCount).toBe(4);
      expect(replay?.coalescedCount).toBe(0);
    });
  });

  it('renders the Hive id as the fixed sender label system (ADR-026)', async () => {
    const hiveId = uuidv7();
    const sender = uuidv7();
    const builder = createBuilder({
      cellsRepo: fakeCellsRepo({ unreadCount: 2, distinctSenderIds: [hiveId, sender] }),
      systemSenderId: hiveId,
    });

    const result = await builder.buildReplayWaggle({ cellId: uuidv7(), recipientId: uuidv7() });

    expect(result?.senderIds).toEqual(['system', sender]);
  });
});
