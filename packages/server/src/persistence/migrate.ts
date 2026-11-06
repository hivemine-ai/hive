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
 * Raised when the database carries migrations this binary does not know: it was migrated by
 * a newer `hivectl`. Running `migrate up` cannot help; the operator upgrades `hivectl`.
 */
export class UnknownMigrationsError extends Error {
  readonly code = 'MIGRATIONS_UNKNOWN' as const;
  readonly unknown: readonly string[];

  constructor(unknown: readonly string[]) {
    super(
      `the database has migrations unknown to this binary: ${unknown.join(', ')}; upgrade hivectl`,
    );
    this.name = 'UnknownMigrationsError';
    this.unknown = unknown;
  }
}

export function isUnknownMigrationsError(err: unknown): err is UnknownMigrationsError {
  return err instanceof UnknownMigrationsError;
}

export interface SchemaStatus {
  /** Migrations recorded in the migration table, catalog or not, sorted. */
  applied: string[];
  /** Catalog migrations not applied yet, sorted. */
  pending: string[];
  /** Applied migrations missing from the catalog (a newer binary ran them), sorted. */
  unknown: string[];
}

const MIGRATION_TABLE = 'kysely_migration';

/** Read-only: checks the table exists before reading it, and never creates it. */
async function listExecutedMigrations(db: Kysely<Database>): Promise<string[]> {
  const tables = await db.introspection.getTables({ withInternalKyselyTables: true });
  if (!tables.some((t) => t.name === MIGRATION_TABLE)) return [];
  const rows = await db
    .selectFrom(MIGRATION_TABLE as never)
    .select(['name'] as never)
    .execute();
  return (rows as { name: string }[]).map((r) => r.name).sort();
}

/** Applied, pending and unknown migrations of the database against the catalog. Read-only. */
export async function getSchemaStatus(
  db: Kysely<Database>,
  opts: MigrateOptions = {},
): Promise<SchemaStatus> {
  const catalog = Object.keys(opts.migrations ?? ALL_MIGRATIONS);
  const applied = await listExecutedMigrations(db);
  const appliedSet = new Set(applied);
  const catalogSet = new Set(catalog);
  return {
    applied,
    pending: catalog.filter((name) => !appliedSet.has(name)).sort(),
    unknown: applied.filter((name) => !catalogSet.has(name)),
  };
}

/** Names of the catalog migrations not yet applied, in application order. Read-only. */
export async function listPendingMigrations(
  db: Kysely<Database>,
  opts: MigrateOptions = {},
): Promise<string[]> {
  return (await getSchemaStatus(db, opts)).pending;
}

/** Applied migrations missing from the catalog, sorted. Read-only. */
export async function listUnknownMigrations(
  db: Kysely<Database>,
  opts: MigrateOptions = {},
): Promise<string[]> {
  return (await getSchemaStatus(db, opts)).unknown;
}

/**
 * Throws {@link UnknownMigrationsError} when the database is newer than the catalog, else
 * {@link PendingMigrationsError} when it is older. Read-only: applies nothing.
 */
export async function assertSchemaUpToDate(
  db: Kysely<Database>,
  opts: MigrateOptions = {},
): Promise<void> {
  const { pending, unknown } = await getSchemaStatus(db, opts);
  if (unknown.length > 0) throw new UnknownMigrationsError(unknown);
  if (pending.length > 0) throw new PendingMigrationsError(pending);
}

function formatMigrationError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return JSON.stringify(err);
}
