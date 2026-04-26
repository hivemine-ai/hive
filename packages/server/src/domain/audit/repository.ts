// Audit Log persistence — direct queries against `audit_log`. Operates on
// already-formed events (id + createdAt set by the recorder); the repository
// is non-transactional with the originating operation per the tech spec
// decision (audit log is observatory, not enforcement).

import type { Kysely, Transaction } from 'kysely';

import type { Database, JsonText } from '#persistence/schema.js';
import { dateToIso, isoToDate, jsonParse } from '#persistence/type-mappers.js';

import type {
  AuditActorKind,
  AuditEvent,
  AuditEventCategory,
  AuditEventDecision,
  AuditSubjectKind,
} from './types.js';

import type { UUIDv7 } from '#domain/auth/types.js';

export type DbExecutor = Kysely<Database> | Transaction<Database>;

/**
 * Row shape for the recorder → repository handoff. The recorder is responsible
 * for generating `id` (uuidv7), setting `createdAt`, and serializing+validating
 * `detail` (max 4096 bytes). The repository persists verbatim.
 */
export interface InsertAuditEventInput {
  id: UUIDv7;
  hiveId: UUIDv7;
  occurredAt: Date;
  createdAt: Date;
  category: AuditEventCategory;
  decision: AuditEventDecision;
  actorId: UUIDv7 | null;
  actorKind: AuditActorKind | null;
  subjectId: UUIDv7 | null;
  subjectKind: AuditSubjectKind | null;
  reasonCode: string | null;
  /** Already JSON-serialized; nullable. */
  detail: JsonText | null;
  requestId: string | null;
}

export interface FindRecentDenialsBySubjectInput {
  hiveId: UUIDv7;
  subjectId: UUIDv7;
  /** Optional cap on rows returned (default 100). */
  limit?: number;
}

export interface FindAuditEventsByFilterInput {
  hiveId: UUIDv7;
  category?: AuditEventCategory;
  actorId?: UUIDv7;
  subjectId?: UUIDv7;
  /** Optional cap on rows returned (default 100). */
  limit?: number;
}

export interface AuditRepo {
  insertAuditEvent(event: InsertAuditEventInput, executor?: DbExecutor): Promise<void>;
  insertAuditEventBatch(events: InsertAuditEventInput[], executor?: DbExecutor): Promise<void>;
  findAuditEventById(id: UUIDv7, hiveId: UUIDv7, executor?: DbExecutor): Promise<AuditEvent | null>;
  findRecentDenialsBySubject(
    input: FindRecentDenialsBySubjectInput,
    executor?: DbExecutor,
  ): Promise<AuditEvent[]>;
  findAuditEventsByFilter(
    input: FindAuditEventsByFilterInput,
    executor?: DbExecutor,
  ): Promise<AuditEvent[]>;
}

interface AuditLogDbRow {
  id: string;
  hive_id: string;
  occurred_at: string;
  created_at: string;
  category: AuditEventCategory;
  decision: AuditEventDecision;
  actor_id: string | null;
  actor_kind: AuditActorKind | null;
  subject_id: string | null;
  subject_kind: AuditSubjectKind | null;
  reason_code: string | null;
  detail: string | null;
  request_id: string | null;
}

function rowToAuditEvent(row: AuditLogDbRow): AuditEvent {
  let parsedDetail: Record<string, unknown> | null = null;
  if (row.detail !== null) {
    try {
      parsedDetail = jsonParse<Record<string, unknown>>(row.detail);
    } catch {
      // Defense-in-depth — corrupted JSON should not poison the read path.
      // The recorder validates before INSERT; reaching here means manual mutation.
      parsedDetail = null;
    }
  }
  return {
    id: row.id,
    hiveId: row.hive_id,
    occurredAt: isoToDate(row.occurred_at),
    createdAt: isoToDate(row.created_at),
    category: row.category,
    decision: row.decision,
    actorId: row.actor_id,
    actorKind: row.actor_kind,
    subjectId: row.subject_id,
    subjectKind: row.subject_kind,
    reasonCode: row.reason_code,
    detail: parsedDetail,
    requestId: row.request_id,
  };
}

function inputToDbValues(event: InsertAuditEventInput): {
  id: string;
  hive_id: string;
  occurred_at: string;
  created_at: string;
  category: AuditEventCategory;
  decision: AuditEventDecision;
  actor_id: string | null;
  actor_kind: AuditActorKind | null;
  subject_id: string | null;
  subject_kind: AuditSubjectKind | null;
  reason_code: string | null;
  detail: string | null;
  request_id: string | null;
} {
  return {
    id: event.id,
    hive_id: event.hiveId,
    occurred_at: dateToIso(event.occurredAt),
    created_at: dateToIso(event.createdAt),
    category: event.category,
    decision: event.decision,
    actor_id: event.actorId,
    actor_kind: event.actorKind,
    subject_id: event.subjectId,
    subject_kind: event.subjectKind,
    reason_code: event.reasonCode,
    detail: event.detail,
    request_id: event.requestId,
  };
}

export function createAuditRepo(db: Kysely<Database>): AuditRepo {
  return {
    async insertAuditEvent(event, executor) {
      const exec = executor ?? db;
      await exec.insertInto('audit_log').values(inputToDbValues(event)).execute();
    },

    async insertAuditEventBatch(events, executor) {
      if (events.length === 0) return;
      const exec = executor ?? db;
      await exec.insertInto('audit_log').values(events.map(inputToDbValues)).execute();
    },

    async findAuditEventById(id, hiveId, executor) {
      const exec = executor ?? db;
      const row = await exec
        .selectFrom('audit_log')
        .selectAll()
        .where('id', '=', id)
        .where('hive_id', '=', hiveId)
        .executeTakeFirst();
      return row ? rowToAuditEvent(row) : null;
    },

    async findRecentDenialsBySubject(input, executor) {
      const exec = executor ?? db;
      const rows = await exec
        .selectFrom('audit_log')
        .selectAll()
        .where('hive_id', '=', input.hiveId)
        .where('subject_id', '=', input.subjectId)
        .where('decision', '=', 'deny')
        .orderBy('occurred_at', 'desc')
        .limit(input.limit ?? 100)
        .execute();
      return rows.map((r) => rowToAuditEvent(r));
    },

    async findAuditEventsByFilter(input, executor) {
      const exec = executor ?? db;
      let q = exec.selectFrom('audit_log').selectAll().where('hive_id', '=', input.hiveId);
      if (input.category !== undefined) q = q.where('category', '=', input.category);
      if (input.actorId !== undefined) q = q.where('actor_id', '=', input.actorId);
      if (input.subjectId !== undefined) q = q.where('subject_id', '=', input.subjectId);
      const rows = await q
        .orderBy('occurred_at', 'desc')
        .limit(input.limit ?? 100)
        .execute();
      return rows.map((r) => rowToAuditEvent(r));
    },
  };
}
