// PRY-096 (INC-2026-010): the read-only schema check (pending and unknown migrations) that `serve` runs before
// it boots. SQLite by default; set HIVE_TEST_PG_URL to run the same suite against Postgres
// (CI `postgres` job). The `public` schema is recreated per test, so point it at a
// throwaway database.

import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDb } from './db.js';
import type { DbDialect } from './db.js';
import {
  assertSchemaUpToDate,
  getSchemaStatus,
  isPendingMigrationsError,
  isUnknownMigrationsError,
  listPendingMigrations,
  listUnknownMigrations,
  migrateToLatest,
  PendingMigrationsError,
  UnknownMigrationsError,
} from './migrate.js';
import { ALL_MIGRATIONS } from './migrations/index.js';
import type { Database } from './schema.js';

const PG_URL = process.env['HIVE_TEST_PG_URL'];
const DIALECT: DbDialect = PG_URL !== undefined && PG_URL !== '' ? 'postgres' : 'sqlite';

// The first migration shipped by v0.3.0; everything before it is the v0.2.2 schema.
const FIRST_V03 = '20261105120000_enrollment-agents-credentials';
const V02_MIGRATIONS = Object.fromEntries(
  Object.entries(ALL_MIGRATIONS).filter(([name]) => name < FIRST_V03),
);
const V03_NAMES = Object.keys(ALL_MIGRATIONS)
  .filter((name) => name >= FIRST_V03)
  .sort();

let db: Kysely<Database>;

beforeEach(async () => {
  if (DIALECT === 'postgres') {
    db = createDb({ dialect: 'postgres', url: PG_URL as string });
    await sql`drop schema if exists public cascade`.execute(db);
    await sql`create schema public`.execute(db);
  } else {
    db = createDb({ dialect: 'sqlite', url: 'sqlite::memory:' });
  }
});

afterEach(async () => {
  await db.destroy();
});

async function migrationTableExists(): Promise<boolean> {
  const rows =
    DIALECT === 'postgres'
      ? await sql<{ name: string }>`
          SELECT table_name AS name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'kysely_migration'
        `.execute(db)
      : await sql<{ name: string }>`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kysely_migration'
        `.execute(db);
  return rows.rows.length > 0;
}

describe(`listPendingMigrations (${DIALECT})`, () => {
  it('lists every migration on an empty database without creating the migration table', async () => {
    const pending = await listPendingMigrations(db);

    expect(pending).toEqual(Object.keys(ALL_MIGRATIONS).sort());
    expect(await migrationTableExists()).toBe(false);
  });

  it('lists only the v0.3.0 migrations on a database at the v0.2.2 schema', async () => {
    await migrateToLatest(db, { migrations: V02_MIGRATIONS });

    expect(await listPendingMigrations(db)).toEqual(V03_NAMES);
  });

  it('lists nothing once the database is fully migrated', async () => {
    await migrateToLatest(db);

    expect(await listPendingMigrations(db)).toEqual([]);
  });
});

describe(`assertSchemaUpToDate (${DIALECT})`, () => {
  it('throws PendingMigrationsError naming the pending migrations and the fix', async () => {
    await migrateToLatest(db, { migrations: V02_MIGRATIONS });

    const err = await assertSchemaUpToDate(db).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PendingMigrationsError);
    expect(isPendingMigrationsError(err)).toBe(true);
    const pendingErr = err as PendingMigrationsError;
    expect(pendingErr.code).toBe('MIGRATIONS_PENDING');
    expect(pendingErr.pending).toEqual(V03_NAMES);
    for (const name of V03_NAMES) expect(pendingErr.message).toContain(name);
    expect(pendingErr.message).toContain('back up the database and run `hivectl migrate up`');
  });

  it('applies nothing: the migration table keeps the v0.2.2 rows', async () => {
    await migrateToLatest(db, { migrations: V02_MIGRATIONS });

    await assertSchemaUpToDate(db).catch(() => undefined);

    const rows = await db
      .selectFrom('kysely_migration' as never)
      .select(['name'] as never)
      .execute();
    expect((rows as { name: string }[]).map((r) => r.name).sort()).toEqual(
      Object.keys(V02_MIGRATIONS).sort(),
    );
  });

  it('resolves on a fully migrated database', async () => {
    await migrateToLatest(db);

    await expect(assertSchemaUpToDate(db)).resolves.toBeUndefined();
  });

  it('isPendingMigrationsError rejects other errors', () => {
    expect(isPendingMigrationsError(new Error('x'))).toBe(false);
    expect(isPendingMigrationsError(undefined)).toBe(false);
  });
});

const FUTURE = '29991231000000_from-a-newer-hivectl';

async function insertUnknownMigration(): Promise<void> {
  await db
    .insertInto('kysely_migration' as never)
    .values({ name: FUTURE, timestamp: new Date().toISOString() })
    .execute();
}

async function executedNames(): Promise<string[]> {
  const rows = await db
    .selectFrom('kysely_migration' as never)
    .select(['name'] as never)
    .execute();
  return (rows as { name: string }[]).map((r) => r.name).sort();
}

describe(`unknown migrations: a database newer than the binary (${DIALECT})`, () => {
  it('listUnknownMigrations is empty on an empty database and does not create the table', async () => {
    expect(await listUnknownMigrations(db)).toEqual([]);
    expect(await migrationTableExists()).toBe(false);
  });

  it('listUnknownMigrations names executed migrations missing from the catalog', async () => {
    await migrateToLatest(db);
    await insertUnknownMigration();

    expect(await listUnknownMigrations(db)).toEqual([FUTURE]);
    expect(await listPendingMigrations(db)).toEqual([]);
  });

  it('assertSchemaUpToDate throws UnknownMigrationsError with the upgrade hint, writing nothing', async () => {
    await migrateToLatest(db);
    await insertUnknownMigration();
    const before = await executedNames();

    const err = await assertSchemaUpToDate(db).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UnknownMigrationsError);
    expect(isUnknownMigrationsError(err)).toBe(true);
    expect(isPendingMigrationsError(err)).toBe(false);
    const unknownErr = err as UnknownMigrationsError;
    expect(unknownErr.code).toBe('MIGRATIONS_UNKNOWN');
    expect(unknownErr.unknown).toEqual([FUTURE]);
    expect(unknownErr.message).toBe(
      `the database has migrations unknown to this binary: ${FUTURE}; upgrade hivectl`,
    );
    expect(await executedNames()).toEqual(before);
  });

  it('reports unknown before pending when both are present', async () => {
    await migrateToLatest(db, { migrations: V02_MIGRATIONS });
    await insertUnknownMigration();

    await expect(assertSchemaUpToDate(db)).rejects.toBeInstanceOf(UnknownMigrationsError);
  });
});

describe(`getSchemaStatus (${DIALECT})`, () => {
  it('splits applied, pending and unknown', async () => {
    await migrateToLatest(db, { migrations: V02_MIGRATIONS });
    await insertUnknownMigration();

    expect(await getSchemaStatus(db)).toEqual({
      applied: [...Object.keys(V02_MIGRATIONS).sort(), FUTURE],
      pending: V03_NAMES,
      unknown: [FUTURE],
    });
  });

  it('is all empty on an empty database except pending', async () => {
    expect(await getSchemaStatus(db)).toEqual({
      applied: [],
      pending: Object.keys(ALL_MIGRATIONS).sort(),
      unknown: [],
    });
  });
});
