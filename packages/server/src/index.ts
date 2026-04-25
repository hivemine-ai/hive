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
