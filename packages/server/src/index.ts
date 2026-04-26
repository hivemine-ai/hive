// Public barrel of @hive/server. Foundation in v0.1: persistence layer + observability.
// Domain modules are added in subsequent slices.

export { createDb, resolveDbConfigFromEnv } from './persistence/db.js';
export type { DbConfig, DbDialect } from './persistence/db.js';

export type {
  Database,
  HivesTable,
  ColoniesTable,
  HivekeepersTable,
  AgentsTable,
  CredentialsTable,
  CredentialRevocationsTable,
  SigningKeysTable,
  DistributedLocksTable,
  CellsTable,
  MessagesTable,
  RetentionPoliciesTable,
  IdempotencyKeysTable,
  AuditLogTable,
  AuditEventCategoryDb,
  AuditDecisionDb,
  AuditActorKindDb,
  AuditSubjectKindDb,
  IsoTimestamp,
  JsonText,
  UUIDv7,
  BooleanInt,
} from './persistence/schema.js';

export { acquireLock, releaseLock, sweepExpiredLocks } from './persistence/lock-table.js';
export type { AcquireLockOptions, ReleaseLockOptions } from './persistence/lock-table.js';

export {
  dateToIso,
  isoToDate,
  jsonStringify,
  jsonParse,
  validateJsonText,
  boolToInt,
  intToBool,
} from './persistence/type-mappers.js';
export type { ValidateJsonTextOptions } from './persistence/type-mappers.js';

export { migrateToLatest, migrateDown } from './persistence/migrate.js';
export type { MigrateOptions } from './persistence/migrate.js';

export { createLogger } from './observability/logger.js';
export type { Logger, LoggerOptions } from './observability/logger.js';

// Auth domain — entire public surface re-exported for downstream packages.
export * from './domain/auth/index.js';

// uuid v7 — re-exported so downstream packages don't need to add `uuid` as a direct dep.
export { v7 as uuidv7 } from 'uuid';

// Cells (Cell Store + Message Persistence) — public surface re-exported for downstream packages.
export * from './domain/cells/index.js';

// Visibility Engine — public contract + types + matrix + engine factory.
export * from './domain/visibility/index.js';

// Audit Log — public types + error class + repository + recorder factories.
export * from './domain/audit/index.js';

// Notifications domain (Waggle Pipeline + Presence Registry) — public surface.
export * from './domain/notifications/index.js';

// Composition root — production wiring helpers.
export { createVisibilityEngineForProduction } from './composition/visibility-engine-factory.js';
export type {
  VisibilityEngineFactoryDeps,
  VisibilityEngineFactoryOptions,
} from './composition/visibility-engine-factory.js';
export {
  createNotificationsForProduction,
  resolveNotificationsConfig,
} from './composition/notifications-factory.js';
export type {
  Notifications,
  NotificationsFactoryDeps,
  NotificationsFactoryOptions,
} from './composition/notifications-factory.js';
export { stubVisibilityEngine } from './composition/stubs.js';
