// Static catalog of all migrations.
// Static imports avoid Kysely's FileMigrationProvider doing dynamic file-system imports
// at runtime — those don't work uniformly across vitest (TS source) and Node ESM
// (JS dist). By importing each migration here we let Vite/tsc handle the loader at
// build/test time and Kysely just sees plain { up, down } modules.

import type { Migration } from 'kysely';

import * as initialAuthTables from './20260425120000_initial-auth-tables.js';
import * as initialCellStoreTables from './20260426120000_initial-cell-store-tables.js';

export const ALL_MIGRATIONS: Record<string, Migration> = {
  '20260425120000_initial-auth-tables': initialAuthTables,
  '20260426120000_initial-cell-store-tables': initialCellStoreTables,
};
