/* eslint-disable @typescript-eslint/no-explicit-any -- Kysely migrations are intentionally
   schema-agnostic; the generic type does not reference the current Database interface. */
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';

// PRY-090 (ADR-026) — widens the audit_log category CHECK with every enrollment category of
// the Visibility Engine + Audit Log tech spec (enrollment events section), so the PRYs of the
// v0.3.0 cascade that record the remaining ones need no further rebuild.
//
// SQLite cannot replace an inline CHECK, so audit_log is rebuilt (create, copy, swap) in
// both dialects. No foreign key references audit_log. Kysely runs Postgres migrations in a
// transaction but not SQLite ones, so the rebuild opens its own when needed.

const V02_CATEGORIES = [
  'visibility_denial',
  'admin_credential_issue',
  'admin_credential_rotate',
  'admin_credential_revoke',
  'admin_signing_key_rotate',
  'admin_hivekeeper_create',
  'admin_hivekeeper_revoke',
  'admin_hivekeeper_admin_grant',
  'admin_hivekeeper_admin_revoke',
  'admin_agent_create',
  'admin_agent_revoke',
  'admin_agent_type_change',
  'admin_agent_suspend',
  'admin_agent_resume',
  'admin_retention_policy_set',
  'admin_retention_policy_clear',
  'admin_purge_run',
  'waggle_push_suppressed',
];

const ENROLLMENT_CATEGORIES = [
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

async function inTransaction(
  db: Kysely<any>,
  fn: (trx: Kysely<any> | Transaction<any>) => Promise<void>,
): Promise<void> {
  if (db.isTransaction) {
    await fn(db);
    return;
  }
  await db.transaction().execute(fn);
}

async function rebuildAuditLog(db: Kysely<any>, categories: string[]): Promise<void> {
  await sql`DROP TABLE IF EXISTS audit_log_rebuild`.execute(db);

  await db.schema
    .createTable('audit_log_rebuild')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('hive_id', 'text', (col) => col.notNull().references('hives.id'))
    .addColumn('occurred_at', 'text', (col) => col.notNull())
    .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn('category', 'text', (col) =>
      col.notNull().check(sql`category IN (${sql.join(categories.map((c) => sql.lit(c)))})`),
    )
    .addColumn('decision', 'text', (col) =>
      col.notNull().check(sql`decision IN ('allow', 'deny', 'success', 'failure')`),
    )
    .addColumn('actor_id', 'text')
    .addColumn('actor_kind', 'text', (col) =>
      col.check(
        sql`actor_kind IS NULL OR actor_kind IN ('hivekeeper', 'worker', 'scout', 'system')`,
      ),
    )
    .addColumn('subject_id', 'text')
    .addColumn('subject_kind', 'text', (col) =>
      col.check(
        sql`subject_kind IS NULL OR subject_kind IN ('participant', 'credential', 'policy', 'cell', 'signing_key', 'audit_log_range')`,
      ),
    )
    .addColumn('reason_code', 'text')
    .addColumn('detail', 'text', (col) => col.check(sql`detail IS NULL OR length(detail) <= 4096`))
    .addColumn('request_id', 'text', (col) =>
      col.check(sql`request_id IS NULL OR length(request_id) <= 128`),
    )
    .addCheckConstraint(
      'audit_log_actor_invariant',
      sql`(actor_id IS NULL AND actor_kind = 'system')
          OR (actor_id IS NOT NULL AND actor_kind IN ('hivekeeper', 'worker', 'scout'))
          OR (actor_id IS NULL AND actor_kind IS NULL)`,
    )
    .execute();

  const columns = sql.raw(
    'id, hive_id, occurred_at, created_at, category, decision, actor_id, actor_kind, ' +
      'subject_id, subject_kind, reason_code, detail, request_id',
  );
  await sql`INSERT INTO audit_log_rebuild (${columns}) SELECT ${columns} FROM audit_log`.execute(
    db,
  );
  await sql`DROP TABLE audit_log`.execute(db);
  await sql`ALTER TABLE audit_log_rebuild RENAME TO audit_log`.execute(db);

  await sql`CREATE INDEX idx_audit_log_hive_occurred ON audit_log (hive_id, occurred_at DESC)`.execute(
    db,
  );
  await sql`CREATE INDEX idx_audit_log_hive_category_occurred ON audit_log (hive_id, category, occurred_at DESC)`.execute(
    db,
  );
  await sql`CREATE INDEX idx_audit_log_hive_actor_occurred ON audit_log (hive_id, actor_id, occurred_at DESC) WHERE actor_id IS NOT NULL`.execute(
    db,
  );
  await sql`CREATE INDEX idx_audit_log_hive_subject_occurred ON audit_log (hive_id, subject_id, occurred_at DESC) WHERE subject_id IS NOT NULL`.execute(
    db,
  );
  await sql`CREATE INDEX idx_audit_log_created_at ON audit_log (created_at)`.execute(db);
}

export async function up(db: Kysely<any>): Promise<void> {
  await inTransaction(db, (trx) =>
    rebuildAuditLog(trx, [...V02_CATEGORIES, ...ENROLLMENT_CATEGORIES]),
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  // Fails on the narrower CHECK while an ADR-026 row exists, instead of dropping it.
  await inTransaction(db, (trx) => rebuildAuditLog(trx, V02_CATEGORIES));
}
