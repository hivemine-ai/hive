// Unit tests for the Waggle builder.

import { v7 as uuidv7 } from 'uuid';
import { describe, expect, it } from 'vitest';

import type { CellsRepo } from '#domain/cells/index.js';

import { createBuilder } from './builder.js';

function fakeCellsRepo(summary: { unreadCount: number; distinctSenderIds: string[] }): CellsRepo {
  return {
    summarizeUnreadForCell: () => Promise.resolve(summary),
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

    const result = await builder.buildOnlineWaggle({ cellId, recipientId });

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
    const args = { cellId: uuidv7(), recipientId: uuidv7() };

    const first = await builder.buildOnlineWaggle(args);
    const second = await builder.buildOnlineWaggle(args);

    expect(first?.waggleId).not.toBe(second?.waggleId);
  });
});
