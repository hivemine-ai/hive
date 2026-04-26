// Public types for the Audit Log domain.
// Sister tech specs (Visibility, Auth admin ops, Cell Store admin ops, Waggle,
// hivectl) import from `domain/audit/index.js` (barrel) which re-exports these.

import type { IdentityContext, UUIDv7 } from '#domain/auth/types.js';

import type {
  AuditActorKind,
  AuditEventCategory,
  AuditEventDecision,
  AuditSubjectKind,
} from './audit-event.js';

export type { AuditActorKind, AuditEventCategory, AuditEventDecision, AuditSubjectKind };

/**
 * AuditEvent as read from the audit_log table. `id` and `createdAt` are
 * server-generated; everything else is provided by the caller of `recordEvent`.
 */
export interface AuditEvent {
  id: UUIDv7;
  occurredAt: Date;
  category: AuditEventCategory;
  decision: AuditEventDecision;
  actorId: UUIDv7 | null;
  actorKind: AuditActorKind | null;
  subjectId: UUIDv7 | null;
  subjectKind: AuditSubjectKind | null;
  reasonCode: string | null;
  /** Parsed JSON object; null if the column was NULL. */
  detail: Record<string, unknown> | null;
  requestId: string | null;
  hiveId: UUIDv7;
  createdAt: Date;
}

/**
 * Input for `recordEvent`. The recorder generates `id` (uuidv7) and `createdAt`
 * before INSERT; the caller does not supply them.
 */
export interface NewAuditEvent {
  category: AuditEventCategory;
  decision: AuditEventDecision;
  actorId: UUIDv7 | null;
  actorKind: AuditActorKind | null;
  subjectId: UUIDv7 | null;
  subjectKind: AuditSubjectKind | null;
  reasonCode: string | null;
  /** Detail object; serialized + size-checked (4096 bytes) by the recorder. */
  detail: Record<string, unknown> | null;
  requestId: string | null;
  hiveId: UUIDv7;
  occurredAt: Date;
}

export interface AuditQueryFilter {
  categories?: AuditEventCategory[];
  decision?: AuditEventDecision;
  actorId?: UUIDv7;
  subjectId?: UUIDv7;
  occurredFrom?: Date;
  occurredUntil?: Date;
  requestId?: string;
}

export interface AuditEventCursor {
  occurredAt: Date;
  id: UUIDv7;
}

export interface AuditQueryInput {
  callerContext: IdentityContext;
  filter?: AuditQueryFilter;
  pagination: {
    cursor: AuditEventCursor | null;
    limit: number;
  };
}

export interface AuditQueryResult {
  events: AuditEvent[];
  nextCursor: AuditEventCursor | null;
}

/**
 * Domain error of the Audit subsystem. Shape aligned with `AuthError` —
 * `code` travels to the wire (admin-only callers), `subCode` stays in logs.
 */
export type AuditErrorCode = 'INSUFFICIENT_PRIVILEGE' | 'INVALID_INPUT';

export type AuditErrorSubCode =
  | 'audit_log_admin_only'
  | 'date_range_inverted'
  | 'limit_exceeded'
  | 'category_unknown'
  | 'request_id_too_long'
  | 'detail_too_large';

export interface AuditErrorOptions {
  subCode?: AuditErrorSubCode;
}

export class AuditError extends Error {
  public readonly code: AuditErrorCode;
  public readonly subCode?: AuditErrorSubCode;

  constructor(code: AuditErrorCode, message: string, options: AuditErrorOptions = {}) {
    super(message);
    this.name = 'AuditError';
    this.code = code;
    if (options.subCode !== undefined) this.subCode = options.subCode;
  }
}

export function isAuditError(value: unknown): value is AuditError {
  return value instanceof AuditError;
}
