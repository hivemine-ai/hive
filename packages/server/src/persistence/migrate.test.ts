import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDb } from './db.js';
import { migrateDown, migrateToLatest } from './migrate.js';
import type { Database } from './schema.js';
import type { Kysely } from 'kysely';

const EXPECTED_TABLES = [
  'agents',
  'colonies',
  'credential_revocations',
  'credentials',
  'distributed_locks',
  'hivekeepers',
  'hives',
  'signing_keys',
];

describe('migrateToLatest', () => {
  let db: Kysely<Database>;

  beforeEach(() => {
    db = createDb({ dialect: 'sqlite', url: 'sqlite::memory:' });
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('creates all 8 tables (7 auth + distributed_locks)', async () => {
    const result = await migrateToLatest(db);
    expect(result.results?.every((r) => r.status === 'Success')).toBe(true);

    const tables = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'kysely_%'
      ORDER BY name
    `.execute(db);
    expect(tables.rows.map((r) => r.name).sort()).toEqual(EXPECTED_TABLES);
  });

  it('is idempotent — running twice does not re-apply migrations', async () => {
    await migrateToLatest(db);
    const second = await migrateToLatest(db);
    expect(second.results?.length ?? 0).toBe(0); // nothing pending
  });

  it('migrateDown rolls back the latest migration cleanly', async () => {
    await migrateToLatest(db);
    const downResult = await migrateDown(db);
    expect(downResult.results?.[0]?.status).toBe('Success');

    const tables = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'kysely_%'
    `.execute(db);
    expect(tables.rows.length).toBe(0);
  });

  it('inserts a default state row with CURRENT_TIMESTAMP working in SQLite', async () => {
    await migrateToLatest(db);
    await db.insertInto('hives').values({ id: 'hive-1', name: 'test hive' }).execute();
    const row = await db
      .selectFrom('hives')
      .selectAll()
      .where('id', '=', 'hive-1')
      .executeTakeFirstOrThrow();
    expect(row.created_at).toBeTruthy();
    expect(row.created_at.length).toBeGreaterThan(0);
  });

  it('enforces UNIQUE INDEX on (hive_id, lower(email)) for hivekeepers', async () => {
    await migrateToLatest(db);
    await db.insertInto('hives').values({ id: 'h', name: 'h' }).execute();
    await db.insertInto('colonies').values({ id: 'c', hive_id: 'h', name: 'c' }).execute();
    await db
      .insertInto('hivekeepers')
      .values({
        id: 'k1',
        hive_id: 'h',
        colony_id: 'c',
        email: 'admin@example.com',
        display_name: null,
        is_admin: 1,
        state: 'active',
        revoked_at: null,
      })
      .execute();

    // Same email with different casing must violate the case-insensitive uniqueness.
    await expect(
      db
        .insertInto('hivekeepers')
        .values({
          id: 'k2',
          hive_id: 'h',
          colony_id: 'c',
          email: 'ADMIN@example.COM',
          display_name: null,
          is_admin: 0,
          state: 'active',
          revoked_at: null,
        })
        .execute(),
    ).rejects.toThrow(/UNIQUE/i);
  });
});
