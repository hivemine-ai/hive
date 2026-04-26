/* eslint-disable @typescript-eslint/no-explicit-any -- Kysely migrations are intentionally
   schema-agnostic; the generic type doesn't reference the current Database interface. */
import type { Kysely } from 'kysely';
import { sql } from 'kysely';

// PRY-004 — initial audit_log table for the Visibility Engine + Audit Log subsystem.
//
// Schema portability per ADR-008:
//   - uuid columns stored as TEXT (UUIDv7 generated client-side by audit/recorder.ts).
//   - timestamps stored as TEXT ISO 8601 (CURRENT_TIMESTAMP for created_at).
//   - detail stored as TEXT with `validateJsonText(detail, 4096)` enforced app-side
//     (no Postgres jsonb). The 4 KB hard ceiling is a CHECK on the column.
//
// Tri-state actor constraint per ADR-007: (NULL, 'system') for system CLI ops,
// (NOT NULL, humano) for authenticated MCP ops, (NULL, NULL) for bootstrap.
//
// Index #5 deviates from tech spec line 585 — the spec proposed a partial
// `WHERE created_at < now() - interval '1 day'` predicate, but `now()` is a
// volatile expression that Postgres rejects in partial-index predicates and
// SQLite would evaluate at index-build time (not query time). Portable +
// correct impl is a plain index on `created_at`, used by the purge job.
// Tech spec amend tracked separately.

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('audit_log')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('hive_id', 'text', (col) => col.notNull().references('hives.id'))
    .addColumn('occurred_at', 'text', (col) => col.notNull())
    .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn('category', 'text', (col) =>
      col.notNull().check(sql`category IN (
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
        'waggle_push_suppressed'
      )`),
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
    // Tri-state actor invariant per ADR-007:
    //   (actor_id NULL, actor_kind 'system')   → system CLI op
    //   (actor_id NOT NULL, actor_kind in {hivekeeper,worker,scout}) → authenticated op
    //   (actor_id NULL, actor_kind NULL)       → bootstrap / extreme cases
    // Forbidden: (actor_id NOT NULL, actor_kind 'system')
    .addCheckConstraint(
      'audit_log_actor_invariant',
      sql`(actor_id IS NULL AND actor_kind = 'system')
          OR (actor_id IS NOT NULL AND actor_kind IN ('hivekeeper', 'worker', 'scout'))
          OR (actor_id IS NULL AND actor_kind IS NULL)`,
    )
    .execute();

  // Hot path: most recent log entries for the Hive.
  await sql`CREATE INDEX idx_audit_log_hive_occurred ON audit_log (hive_id, occurred_at DESC)`.execute(
    db,
  );

  // Filter by category (e.g. "recent denials").
  await sql`CREATE INDEX idx_audit_log_hive_category_occurred ON audit_log (hive_id, category, occurred_at DESC)`.execute(
    db,
  );

  // Partial: "what did this actor do".
  await sql`CREATE INDEX idx_audit_log_hive_actor_occurred ON audit_log (hive_id, actor_id, occurred_at DESC) WHERE actor_id IS NOT NULL`.execute(
    db,
  );

  // Partial: "what happened to this resource".
  await sql`CREATE INDEX idx_audit_log_hive_subject_occurred ON audit_log (hive_id, subject_id, occurred_at DESC) WHERE subject_id IS NOT NULL`.execute(
    db,
  );

  // Supports the purge job filter (DELETE WHERE created_at < cutoff).
  await sql`CREATE INDEX idx_audit_log_created_at ON audit_log (created_at)`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('audit_log').execute();
}
