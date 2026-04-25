// Cross-domain hook from auth → cells. PRY-003 (Cell Store) provides the real
// implementation; in PRY-002 we use a no-op stub so createAgent/revokeAgent
// keep their signatures and tests can spy on it.
//
// The hook receives a Kysely executor (db or transaction) so the cell write
// participates in the same transaction as the agent write.

import type { Kysely, Transaction } from 'kysely';

import type { Database, UUIDv7 } from '#persistence/schema.js';

export type DbExecutor = Kysely<Database> | Transaction<Database>;

export interface CreateCellHookInput {
  ownerId: UUIDv7;
  ownerKind: 'hivekeeper' | 'agent';
  hiveId: UUIDv7;
  colonyId: UUIDv7;
}

export interface CloseCellHookInput {
  ownerId: UUIDv7;
}

export interface CellsRepoHook {
  createCell(executor: DbExecutor, input: CreateCellHookInput): Promise<void>;
  closeCell(executor: DbExecutor, input: CloseCellHookInput): Promise<void>;
}

// PRY-003 will replace this with a real implementation. Until then, no-op.
export const noopCellsHook: CellsRepoHook = {
  async createCell(): Promise<void> {
    /* no-op stub — wired in PRY-003 */
  },
  async closeCell(): Promise<void> {
    /* no-op stub — wired in PRY-003 */
  },
};
