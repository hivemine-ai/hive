import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDb } from './db.js';
import { migrateDown, migrateToLatest } from './migrate.js';
import type { Database } from './schema.js';
import type { Kysely } from 'kysely';

const EXPECTED_AUTH_TABLES = [
  'agents',
  'colonies',
  'credential_revocations',
  'credentials',
  'distributed_locks',
  'hivekeepers',
  'hives',
  'signing_keys',
];

const EXPECTED_CELL_TABLES = ['cells', 'idempotency_keys', 'messages', 'retention_policies'];

const EXPECTED_AUDIT_TABLES = ['audit_log'];

const EXPECTED_TABLES = [
  ...EXPECTED_AUTH_TABLES,
  ...EXPECTED_CELL_TABLES,
  ...EXPECTED_AUDIT_TABLES,
].sort();

describe('migrateToLatest', () => {
  let db: Kysely<Database>;

  beforeEach(() => {
    db = createDb({ dialect: 'sqlite', url: 'sqlite::memory:' });
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('creates the full set of tables (auth + cell store)', async () => {
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

    // `migrateDown` only rolls back the most recent migration (audit log table);
    // the auth + cell store tables should still be present. The audit_log table
    // must be gone.
    const tables = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'kysely_%'
      ORDER BY name
    `.execute(db);
    const remaining = tables.rows.map((r) => r.name).sort();
    const expectedAfterDown = [...EXPECTED_AUTH_TABLES, ...EXPECTED_CELL_TABLES].sort();
    expect(remaining).toEqual(expectedAfterDown);
    for (const auditTable of EXPECTED_AUDIT_TABLES) {
      expect(remaining).not.toContain(auditTable);
    }
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

  it('enforces audit_log actor tri-state invariant per ADR-007', async () => {
    await migrateToLatest(db);
    await db.insertInto('hives').values({ id: 'h', name: 'h' }).execute();

    // Valid: system actor (NULL id, kind='system').
    await db
      .insertInto('audit_log')
      .values({
        id: 'a1',
        hive_id: 'h',
        occurred_at: '2026-04-26T00:00:00.000Z',
        category: 'admin_purge_run',
        decision: 'success',
        actor_id: null,
        actor_kind: 'system',
        subject_id: null,
        subject_kind: null,
        reason_code: null,
        detail: null,
        request_id: null,
      })
      .execute();

    // Valid: authenticated humano (NOT NULL id, kind in {hivekeeper,worker,scout}).
    await db
      .insertInto('audit_log')
      .values({
        id: 'a2',
        hive_id: 'h',
        occurred_at: '2026-04-26T00:00:01.000Z',
        category: 'visibility_denial',
        decision: 'deny',
        actor_id: 'k-1',
        actor_kind: 'worker',
        subject_id: 'k-2',
        subject_kind: 'participant',
        reason_code: 'worker_to_other_owner_worker',
        detail: null,
        request_id: null,
      })
      .execute();

    // Forbidden: (actor_id NOT NULL, actor_kind 'system'). Per ADR-007 invariant.
    await expect(
      db
        .insertInto('audit_log')
        .values({
          id: 'a3',
          hive_id: 'h',
          occurred_at: '2026-04-26T00:00:02.000Z',
          category: 'admin_purge_run',
          decision: 'success',
          actor_id: 'k-1',
          actor_kind: 'system',
          subject_id: null,
          subject_kind: null,
          reason_code: null,
          detail: null,
          request_id: null,
        })
        .execute(),
    ).rejects.toThrow(/CHECK/i);
  });

  it('enforces audit_log category CHECK constraint', async () => {
    await migrateToLatest(db);
    await db.insertInto('hives').values({ id: 'h', name: 'h' }).execute();

    await expect(
      db
        .insertInto('audit_log')
        .values({
          id: 'a1',
          hive_id: 'h',
          occurred_at: '2026-04-26T00:00:00.000Z',
          // @ts-expect-error -- intentionally invalid category to assert CHECK.
          category: 'not_a_real_category',
          decision: 'deny',
          actor_id: null,
          actor_kind: 'system',
          subject_id: null,
          subject_kind: null,
          reason_code: null,
          detail: null,
          request_id: null,
        })
        .execute(),
    ).rejects.toThrow(/CHECK/i);
  });

  it('enforces audit_log detail length cap (4096 bytes)', async () => {
    await migrateToLatest(db);
    await db.insertInto('hives').values({ id: 'h', name: 'h' }).execute();

    const oversize = 'x'.repeat(4097);
    await expect(
      db
        .insertInto('audit_log')
        .values({
          id: 'a1',
          hive_id: 'h',
          occurred_at: '2026-04-26T00:00:00.000Z',
          category: 'visibility_denial',
          decision: 'deny',
          actor_id: 'k-1',
          actor_kind: 'worker',
          subject_id: 'k-2',
          subject_kind: 'participant',
          reason_code: 'worker_to_other_owner_worker',
          detail: oversize,
          request_id: null,
        })
        .execute(),
    ).rejects.toThrow(/CHECK/i);
  });
});
