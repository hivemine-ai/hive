import type { Kysely, Migration, MigrationProvider, MigrationResultSet } from 'kysely';
import { Migrator } from 'kysely';

import { ALL_MIGRATIONS } from './migrations/index.js';
import type { Database } from './schema.js';

export interface MigrateOptions {
  // Override the migrations map. Defaults to the static catalog ALL_MIGRATIONS.
  // Tests can supply a subset to validate ordering / partial migration scenarios.
  migrations?: Record<string, Migration>;
}

function buildMigrator(db: Kysely<Database>, opts: MigrateOptions = {}): Migrator {
  const migrations = opts.migrations ?? ALL_MIGRATIONS;
  const provider: MigrationProvider = {
    getMigrations(): Promise<Record<string, Migration>> {
      return Promise.resolve(migrations);
    },
  };
  return new Migrator({ db, provider });
}

/**
 * Runs all pending migrations against the given Kysely instance.
 * Throws on the first failure.
 */
export async function migrateToLatest(
  db: Kysely<Database>,
  opts: MigrateOptions = {},
): Promise<MigrationResultSet> {
  const migrator = buildMigrator(db, opts);
  const result = await migrator.migrateToLatest();
  if (result.error) {
    throw new Error(`Migration failed: ${formatMigrationError(result.error)}`);
  }
  return result;
}

/**
 * Rolls back the most recent migration. Used by tests.
 */
export async function migrateDown(
  db: Kysely<Database>,
  opts: MigrateOptions = {},
): Promise<MigrationResultSet> {
  const migrator = buildMigrator(db, opts);
  const result = await migrator.migrateDown();
  if (result.error) {
    throw new Error(`Migration down failed: ${formatMigrationError(result.error)}`);
  }
  return result;
}

/**
 * Raised when the database schema is behind the binary: `serve` refuses to boot on it
 * instead of migrating (INC-2026-010). The operator backs up and runs `hivectl migrate up`.
 */
export class PendingMigrationsError extends Error {
  readonly code = 'MIGRATIONS_PENDING' as const;
  readonly pending: readonly string[];

  constructor(pending: readonly string[]) {
    super(
      `the database has ${String(pending.length)} pending migration(s): ${pending.join(', ')}; ` +
        'back up the database and run `hivectl migrate up`',
    );
    this.name = 'PendingMigrationsError';
    this.pending = pending;
  }
}

export function isPendingMigrationsError(err: unknown): err is PendingMigrationsError {
  return err instanceof PendingMigrationsError;
}

/**
 * Names of the catalog migrations not yet applied, in application order. Read-only:
 * Kysely's `getMigrations` only reads the migration table and never creates it.
 */
export async function listPendingMigrations(
  db: Kysely<Database>,
  opts: MigrateOptions = {},
): Promise<string[]> {
  const migrations = await buildMigrator(db, opts).getMigrations();
  return migrations
    .filter((m) => m.executedAt === undefined)
    .map((m) => m.name)
    .sort();
}

/** Throws {@link PendingMigrationsError} when any catalog migration is not applied. */
export async function assertNoPendingMigrations(
  db: Kysely<Database>,
  opts: MigrateOptions = {},
): Promise<void> {
  const pending = await listPendingMigrations(db, opts);
  if (pending.length > 0) throw new PendingMigrationsError(pending);
}

function formatMigrationError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return JSON.stringify(err);
}
