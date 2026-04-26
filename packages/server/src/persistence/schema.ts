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

// ---------- Cell Store (PRY-003) ----------

export interface CellsTable {
  id: UUIDv7;
  hive_id: UUIDv7;
  owner_id: UUIDv7;
  owner_kind: 'hivekeeper' | 'agent';
  state: Generated<'active' | 'closed'>;
  created_at: Generated<IsoTimestamp>;
  closed_at: IsoTimestamp | null;
}

export interface MessagesTable {
  id: UUIDv7;
  cell_id: UUIDv7;
  from_participant_id: UUIDv7;
  to_participant_id: UUIDv7;
  type: 'request' | 'response' | 'notification';
  body: string;
  action: JsonText | null;
  reply_to: UUIDv7 | null;
  ttl_ms: number | null;
  sent_at: Generated<IsoTimestamp>;
  delivered_at: Generated<IsoTimestamp>;
  read_at: IsoTimestamp | null;
  state: Generated<'sent' | 'delivered' | 'read' | 'expired'>;
  expired_at: IsoTimestamp | null;
}

export interface RetentionPoliciesTable {
  id: UUIDv7;
  hive_id: UUIDv7;
  scope: 'hive' | 'hivekeeper';
  scope_id: UUIDv7 | null;
  unread_retention_ms: number | null;
  read_retention_ms: number | null;
  created_at: Generated<IsoTimestamp>;
  updated_at: Generated<IsoTimestamp>;
  frozen_at: IsoTimestamp | null;
  set_by: UUIDv7 | null;
}

export interface IdempotencyKeysTable {
  sender_id: UUIDv7;
  key: string;
  message_id: UUIDv7;
  created_at: Generated<IsoTimestamp>;
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
  cells: CellsTable;
  messages: MessagesTable;
  retention_policies: RetentionPoliciesTable;
  idempotency_keys: IdempotencyKeysTable;
}
