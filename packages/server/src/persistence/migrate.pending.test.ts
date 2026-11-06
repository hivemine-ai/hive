// PRY-096 (INC-2026-010): the read-only pending-migrations check that `serve` runs before
// it boots. SQLite by default; set HIVE_TEST_PG_URL to run the same suite against Postgres
// (CI `postgres` job). The `public` schema is recreated per test, so point it at a
// throwaway database.

import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDb } from './db.js';
import type { DbDialect } from './db.js';
import {
  assertNoPendingMigrations,
  isPendingMigrationsError,
  listPendingMigrations,
  migrateToLatest,
  PendingMigrationsError,
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

describe(`assertNoPendingMigrations (${DIALECT})`, () => {
  it('throws PendingMigrationsError naming the pending migrations and the fix', async () => {
    await migrateToLatest(db, { migrations: V02_MIGRATIONS });

    const err = await assertNoPendingMigrations(db).catch((e: unknown) => e);

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

    await assertNoPendingMigrations(db).catch(() => undefined);

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

    await expect(assertNoPendingMigrations(db)).resolves.toBeUndefined();
  });

  it('isPendingMigrationsError rejects other errors', () => {
    expect(isPendingMigrationsError(new Error('x'))).toBe(false);
    expect(isPendingMigrationsError(undefined)).toBe(false);
  });
});
