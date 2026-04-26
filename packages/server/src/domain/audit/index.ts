// Public barrel for the Audit Log domain.

export { ALL_AUDIT_EVENT_CATEGORIES } from './audit-event.js';

export type {
  AuditActorKind,
  AuditEventCategory,
  AuditEventDecision,
  AuditSubjectKind,
} from './audit-event.js';

export type {
  AuditEventCursor,
  AuditEvent,
  AuditQueryFilter,
  AuditQueryInput,
  AuditQueryResult,
  NewAuditEvent,
} from './types.js';

export { AuditError, isAuditError } from './types.js';

export type { AuditErrorCode, AuditErrorOptions, AuditErrorSubCode } from './types.js';

export { createAuditRepo } from './repository.js';
export type {
  AuditRepo,
  DbExecutor as AuditDbExecutor,
  FindAuditEventsByFilterInput,
  FindRecentDenialsBySubjectInput,
  InsertAuditEventInput,
} from './repository.js';

export {
  createAuditRecorder,
  getAuditRecordFailureCount,
  resetAuditRecordFailureCounters,
  resolveDetailMaxBytes,
} from './recorder.js';
export type { AuditRecorder, RecorderConfig, RecorderDeps } from './recorder.js';
