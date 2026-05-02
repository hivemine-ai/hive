// `hivectl audit query [--category <c>...] [--decision <d>]
//   [--actor-id <email-or-agent-ref-or-uuid>]
//   [--subject-id <email-or-agent-ref-or-uuid>] [--from <iso>] [--until <iso>]
//   [--limit N] [--cursor <cursor>]`
//
// Per the tech spec rationale (cross-spec deltas not implemented here),
// `auditQuery.queryAuditLog` requires a `CallerContext` that the CLI cannot
// fully synthesize for `system` callers. Slice 0 falls back to direct SQL
// against `audit_log`. Parameterized — no injection risk. No audit event of
// its own (read-only).
//
// Per ADR-020 / PRY-042, both `--actor-id` and `--subject-id` accept friendly
// references (Hivekeeper email or agent reference) in addition to the raw
// UUID. The resolver runs **before** the SQL query so audit_log is always
// queried by canonical id-equality — see `resolveAuditParticipantReference`.

import { ALL_AUDIT_EVENT_CATEGORIES } from '@hive/server';
import type { AuditDecisionDb, AuditEventCategoryDb, CliRuntime, UUIDv7 } from '@hive/server';

import { buildOperatorActor } from '#audit/operator-actor.js';
import { CliError } from '#error/cli-error.js';
import { resolveAuditParticipantReference } from '#input/parse-reference.js';
import type { GlobalCliOpts } from '#types.js';

const ALLOWED_DECISIONS: readonly AuditDecisionDb[] = ['allow', 'deny', 'success', 'failure'];

function validateDecision(input: string): AuditDecisionDb {
  if ((ALLOWED_DECISIONS as readonly string[]).includes(input)) {
    return input as AuditDecisionDb;
  }
  throw new CliError('CONFIG_INVALID', {
    subCode: 'decision_invalid',
    message: `--decision '${input}' is not one of: ${ALLOWED_DECISIONS.join(', ')}`,
  });
}

function validateCategories(input: readonly string[]): AuditEventCategoryDb[] {
  const allowed = new Set<string>(ALL_AUDIT_EVENT_CATEGORIES);
  const out: AuditEventCategoryDb[] = [];
  for (const c of input) {
    if (!allowed.has(c)) {
      throw new CliError('CONFIG_INVALID', {
        subCode: 'category_invalid',
        message: `--category '${c}' is not a known audit event category`,
      });
    }
    out.push(c as AuditEventCategoryDb);
  }
  return out;
}

export interface AuditQueryOpts {
  globals: GlobalCliOpts;
  categories: string[] | undefined;
  decision: string | undefined;
  actorId: string | undefined;
  subjectId: string | undefined;
  from: string | undefined;
  until: string | undefined;
  limit: number | undefined;
}

export interface AuditEntry {
  id: UUIDv7;
  category: string;
  decision: string;
  actorId: UUIDv7 | null;
  actorKind: string | null;
  subjectId: UUIDv7 | null;
  subjectKind: string | null;
  reasonCode: string | null;
  detail: Record<string, unknown> | null;
  hiveId: UUIDv7;
  occurredAt: Date;
  createdAt: Date;
}

export async function runAuditQuery(
  runtime: CliRuntime,
  opts: AuditQueryOpts,
): Promise<{ entries: AuditEntry[] }> {
  // Validate `--operator-id` even though `audit query` does not emit an audit event of its own —
  // per ADR-020, the global flag accepts UUID v7 OR Hivekeeper email and must reject malformed
  // inputs / non-admins uniformly across the 7 subcommands that consume it. Without this call,
  // `hivectl audit query --operator-id ghost@example.com` would silently succeed while every
  // other subcommand exits with EXIT_PERMISSION (5) — surprising asymmetry caught in PRY-039
  // code review (S1). The returned actor is intentionally discarded.
  await buildOperatorActor(opts.globals, runtime);

  const limit = clampLimit(opts.limit ?? 50);

  let q = runtime.db
    .selectFrom('audit_log')
    .selectAll()
    .where('hive_id', '=', runtime.hiveStableIdentifier);

  if (opts.categories !== undefined && opts.categories.length > 0) {
    q = q.where('category', 'in', validateCategories(opts.categories));
  }
  if (opts.decision !== undefined) q = q.where('decision', '=', validateDecision(opts.decision));
  if (opts.actorId !== undefined) {
    const actorId = await resolveAuditParticipantReference(opts.actorId, 'actor-id', runtime);
    q = q.where('actor_id', '=', actorId);
  }
  if (opts.subjectId !== undefined) {
    const subjectId = await resolveAuditParticipantReference(opts.subjectId, 'subject-id', runtime);
    q = q.where('subject_id', '=', subjectId);
  }
  if (opts.from !== undefined) q = q.where('occurred_at', '>=', toIso(opts.from, 'from'));
  if (opts.until !== undefined) q = q.where('occurred_at', '<=', toIso(opts.until, 'until'));

  const rows = await q.orderBy('occurred_at', 'desc').orderBy('id', 'desc').limit(limit).execute();
  return {
    entries: rows.map((r) => ({
      id: r.id,
      category: r.category,
      decision: r.decision,
      actorId: r.actor_id,
      actorKind: r.actor_kind,
      subjectId: r.subject_id,
      subjectKind: r.subject_kind,
      reasonCode: r.reason_code,
      detail: r.detail !== null ? (JSON.parse(r.detail) as Record<string, unknown>) : null,
      hiveId: r.hive_id,
      occurredAt: new Date(r.occurred_at),
      createdAt: new Date(r.created_at),
    })),
  };
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 50;
  return Math.min(Math.floor(limit), 500);
}

function toIso(input: string, fieldName: string): string {
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) {
    throw new CliError('CONFIG_INVALID', {
      subCode: 'date_invalid',
      message: `--${fieldName} '${input}' is not a valid ISO 8601 date`,
    });
  }
  return date.toISOString();
}
