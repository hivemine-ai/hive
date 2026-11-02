import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDb } from './db.js';
import { migrateDown, migrateToLatest } from './migrate.js';
import { ALL_MIGRATIONS } from './migrations/index.js';
import * as renameDeliveredToStored from './migrations/20261102120000_rename-delivered-to-stored.js';
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

    // `migrateDown` only rolls back the most recent migration: the rebuild of
    // `messages` that renames `stored_at` back to `delivered_at`. All tables remain.
    const tables = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'kysely_%'
      ORDER BY name
    `.execute(db);
    const remaining = tables.rows.map((r) => r.name).sort();
    expect(remaining).toEqual(EXPECTED_TABLES);

    const messageCols = await sql<{ name: string }>`
      PRAGMA table_info(messages)
    `.execute(db);
    const messageColNames = messageCols.rows.map((r) => r.name);
    expect(messageColNames).toContain('delivered_at');
    expect(messageColNames).not.toContain('stored_at');
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

describe('20261102120000_rename-delivered-to-stored', () => {
  const LATEST = '20261102120000_rename-delivered-to-stored';
  const V01_MIGRATIONS = Object.fromEntries(
    Object.entries(ALL_MIGRATIONS).filter(([name]) => name !== LATEST),
  );

  let db: Kysely<Database>;

  async function seedV01Messages(): Promise<void> {
    await sql`INSERT INTO hives (id, name) VALUES ('h', 'h')`.execute(db);
    await sql`INSERT INTO colonies (id, hive_id, name) VALUES ('c', 'h', 'c')`.execute(db);
    await sql`
      INSERT INTO cells (id, hive_id, owner_id, owner_kind)
      VALUES ('cell-1', 'h', 'p-1', 'agent')
    `.execute(db);
    for (const [id, state] of [
      ['m-delivered', 'delivered'],
      ['m-read', 'read'],
      ['m-expired', 'expired'],
    ] as const) {
      await sql`
        INSERT INTO messages (
          id, cell_id, from_participant_id, to_participant_id, type, body, delivered_at, state
        ) VALUES (
          ${id}, 'cell-1', 'p-2', 'p-1', 'notification', 'hello',
          '2026-05-01T00:00:00.000Z', ${state}
        )
      `.execute(db);
    }
  }

  async function messageRows(timestamp: 'stored_at' | 'delivered_at') {
    const rows = await sql<{ id: string; state: string; at: string }>`
      SELECT id, state, ${sql.ref(timestamp)} AS at FROM messages ORDER BY id
    `.execute(db);
    return rows.rows;
  }

  async function indexes(): Promise<{ name: string; sql: string }[]> {
    const rows = await sql<{ name: string; sql: string }>`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'messages' AND sql IS NOT NULL
      ORDER BY name
    `.execute(db);
    return rows.rows;
  }

  beforeEach(async () => {
    db = createDb({ dialect: 'sqlite', url: 'sqlite::memory:' });
    await migrateToLatest(db, { migrations: V01_MIGRATIONS });
    await seedV01Messages();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('rewrites delivered rows to stored and keeps read and expired on a v0.1 database', async () => {
    await migrateToLatest(db);

    expect(await messageRows('stored_at')).toEqual([
      { id: 'm-delivered', state: 'stored', at: '2026-05-01T00:00:00.000Z' },
      { id: 'm-expired', state: 'expired', at: '2026-05-01T00:00:00.000Z' },
      { id: 'm-read', state: 'read', at: '2026-05-01T00:00:00.000Z' },
    ]);
  });

  it('replaces the CHECK: stored is accepted and delivered is rejected', async () => {
    await migrateToLatest(db);

    const insert = (id: string, state: string) => sql`
      INSERT INTO messages (id, cell_id, from_participant_id, to_participant_id, type, body, state)
      VALUES (${id}, 'cell-1', 'p-2', 'p-1', 'notification', 'hello', ${state})
    `;

    await expect(insert('m-new', 'stored').execute(db)).resolves.toBeDefined();
    await expect(insert('m-old', 'delivered').execute(db)).rejects.toThrow(/CHECK/i);
  });

  it('defaults new rows to the stored state', async () => {
    await migrateToLatest(db);

    await sql`
      INSERT INTO messages (id, cell_id, from_participant_id, to_participant_id, type, body)
      VALUES ('m-default', 'cell-1', 'p-2', 'p-1', 'notification', 'hello')
    `.execute(db);

    const rows = await messageRows('stored_at');
    expect(rows.find((r) => r.id === 'm-default')?.state).toBe('stored');
  });

  it('recreates the indexes against stored_at and the partial index on stored', async () => {
    await migrateToLatest(db);

    const all = await indexes();
    expect(all.map((i) => i.name)).toEqual([
      'idx_messages_cell_stored',
      'idx_messages_cell_unread',
      'idx_messages_expired',
      'idx_messages_reply_to',
      'idx_messages_sent_at',
    ]);
    const unread = all.find((i) => i.name === 'idx_messages_cell_unread');
    expect(unread?.sql).toMatch(/stored_at/);
    expect(unread?.sql).toMatch(/WHERE state = 'stored'/);
    expect(all.map((i) => i.sql).join(' ')).not.toMatch(/delivered/);
  });

  it('is idempotent when up runs on an already migrated database', async () => {
    await migrateToLatest(db);
    const before = await messageRows('stored_at');

    await renameDeliveredToStored.up(db);

    expect(await messageRows('stored_at')).toEqual(before);
  });

  it('is reversible: down restores delivered_at, the delivered state and the old indexes', async () => {
    await migrateToLatest(db);
    await migrateDown(db);

    expect(await messageRows('delivered_at')).toEqual([
      { id: 'm-delivered', state: 'delivered', at: '2026-05-01T00:00:00.000Z' },
      { id: 'm-expired', state: 'expired', at: '2026-05-01T00:00:00.000Z' },
      { id: 'm-read', state: 'read', at: '2026-05-01T00:00:00.000Z' },
    ]);
    expect((await indexes()).map((i) => i.name)).toContain('idx_messages_cell_delivered');

    await migrateToLatest(db);
    expect((await messageRows('stored_at')).map((r) => r.state)).toEqual([
      'stored',
      'expired',
      'read',
    ]);
  });
});
