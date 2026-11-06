// PRY-090 milestone 1: the ADR-026 schema delta on `agents` and `credentials`.
// Runs against SQLite by default; set HIVE_TEST_PG_URL to run the same suite against
// Postgres (CI `postgres` job). The `public` schema is recreated per test, so point it at
// a throwaway database.

import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDb } from './db.js';
import type { DbDialect } from './db.js';
import { migrateDown, migrateToLatest } from './migrate.js';
import { ALL_MIGRATIONS } from './migrations/index.js';
import type { Database } from './schema.js';

const PG_URL = process.env['HIVE_TEST_PG_URL'];
const DIALECT: DbDialect = PG_URL !== undefined && PG_URL !== '' ? 'postgres' : 'sqlite';

const LATEST = '20261105120000_enrollment-agents-credentials';
const V02_MIGRATIONS = Object.fromEntries(
  Object.entries(ALL_MIGRATIONS).filter(([name]) => name < LATEST),
);
// Later migrations are left out so `migrateDown` rolls back this one.
const THROUGH_LATEST = {
  migrations: Object.fromEntries(Object.entries(ALL_MIGRATIONS).filter(([name]) => name <= LATEST)),
};

async function freshDb(): Promise<Kysely<Database>> {
  if (DIALECT === 'postgres') {
    const db = createDb({ dialect: 'postgres', url: PG_URL as string });
    await sql`drop schema if exists public cascade`.execute(db);
    await sql`create schema public`.execute(db);
    return db;
  }
  return createDb({ dialect: 'sqlite', url: 'sqlite::memory:' });
}

async function indexDefinitions(table: string): Promise<Map<string, string>> {
  const rows =
    DIALECT === 'postgres'
      ? await sql<{ name: string; def: string }>`
          SELECT indexname AS name, indexdef AS def FROM pg_indexes
          WHERE schemaname = 'public' AND tablename = ${table}
        `.execute(db)
      : await sql<{ name: string; def: string }>`
          SELECT name, sql AS def FROM sqlite_master
          WHERE type = 'index' AND tbl_name = ${table} AND sql IS NOT NULL
        `.execute(db);
  return new Map(rows.rows.map((r) => [r.name, r.def.replace(/\s+/g, ' ')]));
}

let db: Kysely<Database>;

async function seedV02World(): Promise<void> {
  await sql`INSERT INTO hives (id, name) VALUES ('h', 'h')`.execute(db);
  await sql`INSERT INTO colonies (id, hive_id, name) VALUES ('c', 'h', 'c')`.execute(db);
  await sql`
    INSERT INTO hivekeepers (id, hive_id, colony_id, email, is_admin, state)
    VALUES ('hk', 'h', 'c', 'hk@example.com', 1, 'active')
  `.execute(db);
  for (const [id, name, state] of [
    ['a-active', 'alpha', 'active'],
    ['a-suspended', 'beta', 'suspended'],
    ['a-revoked', 'gamma', 'revoked'],
  ] as const) {
    await sql`
      INSERT INTO agents (id, hive_id, colony_id, owner_id, name, type, capabilities, state,
                          last_connected_at)
      VALUES (${id}, 'h', 'c', 'hk', ${name}, 'worker', '["x"]', ${state},
              '2026-05-01T00:00:00.000Z')
    `.execute(db);
  }
  await sql`
    INSERT INTO credentials (jti, participant_id, participant_kind, kid, expires_at, snapshot)
    VALUES ('j-1', 'a-active', 'worker', 'k', '2027-01-01T00:00:00.000Z', '{}')
  `.execute(db);
}

async function insertAgent(id: string, overrides: Record<string, unknown>): Promise<void> {
  await db
    .insertInto('agents')
    .values({
      id,
      hive_id: 'h',
      colony_id: 'c',
      owner_id: 'hk',
      name: id,
      type: 'worker',
      capabilities: '[]',
      instructions: '',
      state: 'active',
      revoked_at: null,
      last_connected_at: null,
      ...overrides,
    })
    .execute();
}

describe(`${LATEST} (${DIALECT})`, () => {
  beforeEach(async () => {
    db = await freshDb();
    await migrateToLatest(db, { migrations: V02_MIGRATIONS });
    await seedV02World();
    await migrateToLatest(db, THROUGH_LATEST);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('keeps every v0.2.x agent and marks it origin = manual with the new columns empty', async () => {
    const rows = await db
      .selectFrom('agents')
      .select([
        'id',
        'name',
        'state',
        'capabilities',
        'last_connected_at',
        'origin',
        'enrolled_via',
        'description',
        'retired_at',
        'last_worker_jti',
      ])
      .orderBy('id')
      .execute();
    expect(rows).toEqual(
      [
        ['a-active', 'alpha', 'active'],
        ['a-revoked', 'gamma', 'revoked'],
        ['a-suspended', 'beta', 'suspended'],
      ].map(([id, name, state]) => ({
        id,
        name,
        state,
        capabilities: '["x"]',
        last_connected_at: '2026-05-01T00:00:00.000Z',
        origin: 'manual',
        enrolled_via: null,
        description: null,
        retired_at: null,
        last_worker_jti: null,
      })),
    );
  });

  it('leaves existing credentials with a NULL scope and enrolled_via', async () => {
    const row = await db
      .selectFrom('credentials')
      .select(['jti', 'scope', 'enrolled_via'])
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ jti: 'j-1', scope: null, enrolled_via: null });
  });

  it('accepts the retired state together with retired_at', async () => {
    await insertAgent('a-retired', {
      state: 'retired',
      retired_at: '2026-11-01T00:00:00.000Z',
      origin: 'enrollment',
      enrolled_via: 'enr-1',
    });
    const row = await db
      .selectFrom('agents')
      .select('state')
      .where('id', '=', 'a-retired')
      .executeTakeFirstOrThrow();
    expect(row.state).toBe('retired');
  });

  it('rejects an unknown state and an unknown origin', async () => {
    await expect(insertAgent('a-bad-state', { state: 'gone' })).rejects.toThrow(/check/i);
    await expect(insertAgent('a-bad-origin', { origin: 'imported' })).rejects.toThrow(/check/i);
  });

  it('rejects enrolled_via on a manual agent', async () => {
    await expect(
      insertAgent('a-manual-enrolled', { origin: 'manual', enrolled_via: 'enr-1' }),
    ).rejects.toThrow(/check/i);
  });

  it('rejects retired_at on an agent that is not retired', async () => {
    await expect(
      insertAgent('a-active-retired-at', { retired_at: '2026-11-01T00:00:00.000Z' }),
    ).rejects.toThrow(/check/i);
  });

  it('accepts a 280-character description and rejects 281 characters', async () => {
    await insertAgent('a-desc-280', { description: 'd'.repeat(280) });
    await expect(insertAgent('a-desc-281', { description: 'd'.repeat(281) })).rejects.toThrow(
      /check/i,
    );
  });

  it('still enforces the hivekeeper foreign key on owner_id', async () => {
    await expect(insertAgent('a-orphan', { owner_id: 'nobody' })).rejects.toThrow(/foreign key/i);
  });

  it('still enforces the unique (owner_id, name) among non-revoked agents', async () => {
    await expect(insertAgent('a-dup', { name: 'alpha' })).rejects.toThrow(/unique/i);
    await insertAgent('a-reuse', { name: 'gamma' });
  });

  it('rejects an unknown credential scope and accepts enroll', async () => {
    const base = {
      participant_id: 'hk',
      participant_kind: 'hivekeeper' as const,
      kid: 'k',
      expires_at: '2027-01-01T00:00:00.000Z',
      snapshot: '{}',
      issued_by: null,
      revoked_at: null,
    };
    await db
      .insertInto('credentials')
      .values({ ...base, jti: 'j-enroll', scope: 'enroll' })
      .execute();
    await expect(
      db
        .insertInto('credentials')
        .values({ ...base, jti: 'j-admin', scope: 'admin' as 'enroll' })
        .execute(),
    ).rejects.toThrow(/check/i);
  });

  it('recreates the pre-existing agents indexes and adds the three enrollment indexes', async () => {
    const defs = await indexDefinitions('agents');
    expect(defs.get('agents_owner_name_active_uq')).toMatch(
      /UNIQUE INDEX .*\(owner_id, name\) WHERE .*state.* <> .*'revoked'|UNIQUE INDEX .*\(owner_id, name\) WHERE state != 'revoked'/,
    );
    expect(defs.get('idx_agents_owner_active')).toMatch(/\(owner_id, state\) WHERE/);
    expect(defs.get('idx_agents_active_scouts')).toMatch(/\(hive_id, type, state\) WHERE/);
    expect(defs.get('idx_agents_enrolled_via_active')).toMatch(
      /\(enrolled_via\) WHERE .*state.* = 'active'/,
    );
    expect(defs.get('idx_agents_enrollment_retirement')).toMatch(
      /\(last_connected_at\) WHERE .*origin.* = 'enrollment'.* AND .*state.* = 'active'/,
    );
    expect(defs.get('idx_agents_retired_grace')).toMatch(
      /\(retired_at\) WHERE .*state.* = 'retired'/,
    );
  });

  it('adds the partial index on credentials.enrolled_via', async () => {
    const defs = await indexDefinitions('credentials');
    expect(defs.get('idx_credentials_enrolled_via')).toMatch(
      /\(enrolled_via\) WHERE .*enrolled_via IS NOT NULL/,
    );
    expect(defs.has('idx_credentials_participant_expires')).toBe(true);
  });

  it('is reversible: down restores the v0.2.x agents and credentials shape', async () => {
    await migrateDown(db, THROUGH_LATEST);
    const agentCols = await db.introspection.getTables();
    const agents = agentCols.find((t) => t.name === 'agents');
    const credentials = agentCols.find((t) => t.name === 'credentials');
    const agentNames = agents?.columns.map((c) => c.name) ?? [];
    expect(agentNames).toContain('last_connected_at');
    for (const col of ['origin', 'enrolled_via', 'description', 'retired_at', 'last_worker_jti']) {
      expect(agentNames).not.toContain(col);
    }
    const credentialNames = credentials?.columns.map((c) => c.name) ?? [];
    expect(credentialNames).not.toContain('scope');
    expect(credentialNames).not.toContain('enrolled_via');
    const count = await db
      .selectFrom('agents')
      .select((eb) => eb.fn.countAll<string | number>().as('n'))
      .executeTakeFirstOrThrow();
    expect(Number(count.n)).toBe(3);
    await expect(
      sql`UPDATE agents SET state = 'retired' WHERE id = 'a-active'`.execute(db),
    ).rejects.toThrow(/check/i);
  });
});
