// Waggle payload builder — pure from Waggle's POV; all persistence delegated
// to Cell Store. Per the tech spec § "waggle/builder.ts": builds the semantic
// shape that the MCP transport later translates to the wire. Returns null when
// the Cell is empty (`unreadCount === 0`) — the caller MUST not emit Waggle.

import { v7 as uuidv7 } from 'uuid';

import type { UUIDv7 } from '#domain/auth/types.js';

import type { CellsRepo } from '#domain/cells/index.js';

import type { WaggleNotification } from './types.js';

export interface BuilderDeps {
  cellsRepo: CellsRepo;
}

export interface Builder {
  /** Online-mode payload — fired after the consolidator flushes a Cell window. */
  buildOnlineWaggle(input: {
    cellId: UUIDv7;
    recipientId: UUIDv7;
  }): Promise<WaggleNotification | null>;

  /** Replay-mode payload — fired after subscribe re-verifies Cell + state. */
  buildReplayWaggle(input: {
    cellId: UUIDv7;
    recipientId: UUIDv7;
  }): Promise<WaggleNotification | null>;
}

export function createBuilder(deps: BuilderDeps): Builder {
  return {
    async buildOnlineWaggle({ cellId, recipientId }) {
      const summary = await deps.cellsRepo.summarizeUnreadForCell(cellId);
      if (summary.unreadCount === 0) return null;
      return {
        kind: 'online',
        cellId,
        recipientId,
        unreadCount: summary.unreadCount,
        senderIds: summary.distinctSenderIds,
        emittedAt: new Date(),
        waggleId: uuidv7(),
      };
    },

    async buildReplayWaggle({ cellId, recipientId }) {
      const summary = await deps.cellsRepo.summarizeUnreadForCell(cellId);
      if (summary.unreadCount === 0) return null;
      return {
        kind: 'replay',
        cellId,
        recipientId,
        unreadCount: summary.unreadCount,
        senderIds: summary.distinctSenderIds,
        emittedAt: new Date(),
        waggleId: uuidv7(),
      };
    },
  };
}
