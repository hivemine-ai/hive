// PRY-090 milestone 6: the ADR-026 audit categories. Runs against SQLite by default; set
// HIVE_TEST_PG_URL to run it against Postgres (CI `postgres` job). The `public` schema is
// recreated per test, so point it at a throwaway database.

import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ALL_AUDIT_EVENT_CATEGORIES } from '#domain/audit/audit-event.js';
import { createDb } from './db.js';
import { migrateDown, migrateToLatest } from './migrate.js';
import { ALL_MIGRATIONS } from './migrations/index.js';
import type { Database } from './schema.js';

const PG_URL = process.env['HIVE_TEST_PG_URL'];
const DIALECT = PG_URL !== undefined && PG_URL !== '' ? 'postgres' : 'sqlite';
const LATEST = '20261105130000_audit-enrollment-categories';
const BEFORE = Object.fromEntries(Object.entries(ALL_MIGRATIONS).filter(([name]) => name < LATEST));
const ADR_026_CATEGORIES = [
  'enrollment_credential_issued',
  'enrollment_credential_rotated',
  'enrollment_credential_revoked',
  'agent_enrolled',
  'agent_claimed',
  'agent_retired',
  'agent_revived',
  'admin_agent_release',
  'enrollment_reject_alert',
];

let db: Kysely<Database>;

function insertAudit(id: string, category: string) {
  return sql`
    INSERT INTO audit_log (id, hive_id, occurred_at, category, decision, actor_kind)
    VALUES (${id}, 'h', '2026-11-05T00:00:00.000Z', ${category}, 'success', 'system')
  `.execute(db);
}

async function indexNames(): Promise<string[]> {
  const rows =
    DIALECT === 'postgres'
      ? await sql<{ name: string }>`
          SELECT indexname AS name FROM pg_indexes
          WHERE schemaname = 'public' AND tablename = 'audit_log' AND indexname NOT LIKE '%_pkey'
        `.execute(db)
      : await sql<{ name: string }>`
          SELECT name FROM sqlite_master
          WHERE type = 'index' AND tbl_name = 'audit_log' AND sql IS NOT NULL
        `.execute(db);
  return rows.rows.map((r) => r.name).sort();
}

describe(`${LATEST} (${DIALECT})`, () => {
  beforeEach(async () => {
    if (DIALECT === 'postgres') {
      db = createDb({ dialect: 'postgres', url: PG_URL as string });
      await sql`drop schema if exists public cascade`.execute(db);
      await sql`create schema public`.execute(db);
    } else {
      db = createDb({ dialect: 'sqlite', url: 'sqlite::memory:' });
    }
    await migrateToLatest(db, { migrations: BEFORE });
    await sql`INSERT INTO hives (id, name) VALUES ('h', 'h')`.execute(db);
    await insertAudit('a-old', 'admin_credential_issue');
    await migrateToLatest(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('accepts every ADR-026 category and keeps the existing rows', async () => {
    for (const [i, category] of ADR_026_CATEGORIES.entries()) {
      await insertAudit(`a-${i}`, category);
    }
    const rows = await db.selectFrom('audit_log').select('id').execute();
    expect(rows).toHaveLength(ADR_026_CATEGORIES.length + 1);
  });

  it('still rejects an unknown category and keeps the actor invariant', async () => {
    await expect(insertAudit('a-bad', 'agent_teleported')).rejects.toThrow(/check/i);
    await expect(
      sql`
        INSERT INTO audit_log (id, hive_id, occurred_at, category, decision, actor_id, actor_kind)
        VALUES ('a-sys', 'h', '2026-11-05T00:00:00.000Z', 'agent_retired', 'success', 'x', 'system')
      `.execute(db),
    ).rejects.toThrow(/check/i);
  });

  it('recreates the audit_log indexes', async () => {
    expect(await indexNames()).toEqual([
      'idx_audit_log_created_at',
      'idx_audit_log_hive_actor_occurred',
      'idx_audit_log_hive_category_occurred',
      'idx_audit_log_hive_occurred',
      'idx_audit_log_hive_subject_occurred',
    ]);
  });

  it('matches the domain list of categories', () => {
    for (const category of ADR_026_CATEGORIES) {
      expect(ALL_AUDIT_EVENT_CATEGORIES).toContain(category);
    }
  });

  it('is reversible while no ADR-026 row exists', async () => {
    await migrateDown(db);
    await expect(insertAudit('a-new', 'agent_enrolled')).rejects.toThrow(/check/i);
    const rows = await db.selectFrom('audit_log').select('id').execute();
    expect(rows.map((r) => r.id)).toEqual(['a-old']);
  });
});
