// Cross-domain hook from auth → cells. PRY-003 (Cell Store) provides the real
// implementation; in tests and in scenarios where cells are not wired we use a
// no-op stub so createAgent / revokeAgent / revokeHivekeeperWithCascade keep
// their signatures and tests can spy on it.
//
// The hook receives a Kysely executor (db or transaction) so the cell write
// participates in the same transaction as the participant write.

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

export interface CloseCellsByOwnerHookInput {
  ownerIds: UUIDv7[];
}

export interface CellsRepoHook {
  createCell(executor: DbExecutor, input: CreateCellHookInput): Promise<void>;
  closeCell(executor: DbExecutor, input: CloseCellHookInput): Promise<void>;
  // Batch close for the cascade Hivekeeper → owned Agents. Cell Store maps
  // each ownerId to its single Cell (UNIQUE on cells.owner_id) and closes them
  // atomically inside the same transaction.
  closeCellsByOwner(executor: DbExecutor, input: CloseCellsByOwnerHookInput): Promise<void>;
}

// Default no-op stub. Used when cells wiring is intentionally absent (older
// tests, fixtures that pre-seed cells separately). PRY-003's composition root
// replaces this with the real adapter.
export const noopCellsHook: CellsRepoHook = {
  async createCell(): Promise<void> {
    /* no-op stub */
  },
  async closeCell(): Promise<void> {
    /* no-op stub */
  },
  async closeCellsByOwner(): Promise<void> {
    /* no-op stub */
  },
};
