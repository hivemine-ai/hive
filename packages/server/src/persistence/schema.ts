import type { Generated } from 'kysely';

// All UUID v7 values are stored as TEXT for portability between SQLite and Postgres.
export type UUIDv7 = string;

// Timestamps are stored as ISO 8601 TEXT (e.g. "2026-04-25T12:34:56.789Z").
// Default value `CURRENT_TIMESTAMP` is the standard SQL keyword, supported by both dialects.
export type IsoTimestamp = string;

// JSON payloads (snapshots, JWKs, capability arrays) are stored as TEXT and validated at the
// application layer. SQLite has no native JSONB type, and Postgres `jsonb` is available via
// the same TEXT column when accessed through Kysely.
export type JsonText = string;

// Booleans are stored as INTEGER 0/1 for SQLite portability. The repository layer converts
// to/from JS `boolean` at its boundary.
export type BooleanInt = 0 | 1;

export interface HivesTable {
  id: UUIDv7;
  name: string;
  created_at: Generated<IsoTimestamp>;
}

export interface ColoniesTable {
  id: UUIDv7;
  hive_id: UUIDv7;
  name: string;
  created_at: Generated<IsoTimestamp>;
}

export interface HivekeepersTable {
  id: UUIDv7;
  hive_id: UUIDv7;
  colony_id: UUIDv7;
  email: string;
  display_name: string | null;
  is_admin: BooleanInt;
  state: 'active' | 'revoked';
  created_at: Generated<IsoTimestamp>;
  revoked_at: IsoTimestamp | null;
}

export interface AgentsTable {
  id: UUIDv7;
  hive_id: UUIDv7;
  colony_id: UUIDv7;
  owner_id: UUIDv7;
  name: string;
  type: 'worker' | 'scout';
  capabilities: JsonText;
  instructions: string;
  state: 'active' | 'suspended' | 'revoked';
  created_at: Generated<IsoTimestamp>;
  revoked_at: IsoTimestamp | null;
}

export interface CredentialsTable {
  jti: UUIDv7;
  participant_id: UUIDv7;
  participant_kind: 'hivekeeper' | 'worker' | 'scout';
  kid: string;
  issued_at: Generated<IsoTimestamp>;
  not_before: Generated<IsoTimestamp>;
  expires_at: IsoTimestamp;
  snapshot: JsonText;
  issued_by: UUIDv7 | null;
  revoked_at: IsoTimestamp | null;
}

export interface CredentialRevocationsTable {
  jti: UUIDv7;
  revoked_at: Generated<IsoTimestamp>;
  revoked_by: UUIDv7 | null;
  reason: string | null;
  credential_expires_at: IsoTimestamp;
}

export interface SigningKeysTable {
  kid: string;
  algorithm: string;
  public_jwk: JsonText;
  created_at: Generated<IsoTimestamp>;
  retired_at: IsoTimestamp | null;
  removed_at: IsoTimestamp | null;
}

export interface DistributedLocksTable {
  lock_id: string;
  owner_id: string;
  acquired_at: IsoTimestamp;
  expires_at: IsoTimestamp;
}

export interface Database {
  hives: HivesTable;
  colonies: ColoniesTable;
  hivekeepers: HivekeepersTable;
  agents: AgentsTable;
  credentials: CredentialsTable;
  credential_revocations: CredentialRevocationsTable;
  signing_keys: SigningKeysTable;
  distributed_locks: DistributedLocksTable;
}
