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

function formatMigrationError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return JSON.stringify(err);
}
