// Static catalog of all migrations.
// Static imports avoid Kysely's FileMigrationProvider doing dynamic file-system imports
// at runtime — those don't work uniformly across vitest (TS source) and Node ESM
// (JS dist). By importing each migration here we let Vite/tsc handle the loader at
// build/test time and Kysely just sees plain { up, down } modules.

import type { Migration } from 'kysely';

import * as initialAuthTables from './20260425120000_initial-auth-tables.js';
import * as initialCellStoreTables from './20260426120000_initial-cell-store-tables.js';
import * as initialAuditLogTable from './20260426130000_initial-audit-log-table.js';
import * as idempotencyKeyScopeRecipient from './20260430120000_idempotency-key-scope-recipient.js';
import * as addLastConnectedAtToAgents from './20260501120000_add-last-connected-at-to-agents.js';

export const ALL_MIGRATIONS: Record<string, Migration> = {
  '20260425120000_initial-auth-tables': initialAuthTables,
  '20260426120000_initial-cell-store-tables': initialCellStoreTables,
  '20260426130000_initial-audit-log-table': initialAuditLogTable,
  '20260430120000_idempotency-key-scope-recipient': idempotencyKeyScopeRecipient,
  '20260501120000_add-last-connected-at-to-agents': addLastConnectedAtToAgents,
};
