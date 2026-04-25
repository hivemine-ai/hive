import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Kysely, MigrationProvider, MigrationResultSet } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely';
import * as fs from 'node:fs/promises';

import type { Database } from './schema.js';

export interface MigrateOptions {
  // Override the migrations directory. Defaults to ./migrations relative to this file.
  migrationsDir?: string;
}

function defaultMigrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, 'migrations');
}

function buildMigrator(db: Kysely<Database>, opts: MigrateOptions = {}): Migrator {
  const provider: MigrationProvider = new FileMigrationProvider({
    fs,
    path,
    migrationFolder: opts.migrationsDir ?? defaultMigrationsDir(),
  });
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
