// Waggle payload builder — pure from Waggle's POV; all persistence delegated
// to Cell Store. Per the tech spec § "waggle/builder.ts": builds the semantic
// shape that the MCP transport later translates to the wire. Returns null when
// the Cell is empty (`unreadCount === 0`) — the caller MUST not emit Waggle.

import { createHash } from 'node:crypto';

import { v7 as uuidv7 } from 'uuid';

import type { UUIDv7 } from '#domain/auth/types.js';

import type { CellsRepo } from '#domain/cells/index.js';

import type { WaggleKind, WaggleNotification } from './types.js';

export interface BuilderDeps {
  cellsRepo: CellsRepo;
}

export interface Builder {
  /** Online-mode payload — fired after the consolidator flushes a Cell window. */
  buildOnlineWaggle(input: {
    cellId: UUIDv7;
    recipientId: UUIDv7;
    coalescedCount: number;
  }): Promise<WaggleNotification | null>;

  /** Replay-mode payload — fired after subscribe re-verifies Cell + state. */
  buildReplayWaggle(input: {
    cellId: UUIDv7;
    recipientId: UUIDv7;
  }): Promise<WaggleNotification | null>;
}

/**
 * Pure and stable across processes and v0.2.x versions: clients compare these ids
 * across reconnections. The separator keeps the three fields from running together.
 */
export function deriveEventId(
  cellId: UUIDv7,
  latestMessageId: UUIDv7 | null,
  unreadCount: number,
): string {
  return createHash('sha256')
    .update(`${cellId}\n${latestMessageId ?? ''}\n${String(unreadCount)}`)
    .digest('hex');
}

export function createBuilder(deps: BuilderDeps): Builder {
  async function build(
    kind: WaggleKind,
    cellId: UUIDv7,
    recipientId: UUIDv7,
    coalescedCount: number,
  ): Promise<WaggleNotification | null> {
    const summary = await deps.cellsRepo.summarizeUnreadForCell(cellId);
    if (summary.unreadCount === 0) return null;
    return {
      kind,
      eventId: deriveEventId(cellId, summary.latestMessageId, summary.unreadCount),
      cellId,
      recipientId,
      unreadCount: summary.unreadCount,
      coalescedCount,
      senderIds: summary.distinctSenderIds,
      emittedAt: new Date(),
      waggleId: uuidv7(),
    };
  }

  return {
    buildOnlineWaggle: ({ cellId, recipientId, coalescedCount }) =>
      build('online', cellId, recipientId, coalescedCount),
    buildReplayWaggle: ({ cellId, recipientId }) => build('replay', cellId, recipientId, 0),
  };
}
