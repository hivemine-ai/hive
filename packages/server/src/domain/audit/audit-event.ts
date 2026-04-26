// Source-of-truth enumerations for the Audit Log domain.
// Per the Visibility Engine + Audit Log tech spec — every other tech spec that
// records to the audit log imports `AuditEventCategory` from here (re-exported
// by `audit/types.ts`). Adding a new category requires:
//   1. Editing the union below.
//   2. Bumping the CHECK constraint in a new migration.
// The DB-side type lives in `persistence/schema.ts::AuditEventCategoryDb` and
// MUST stay in sync with this union.

export type AuditEventCategory =
  // === Visibility Engine ===
  | 'visibility_denial'
  // === Auth admin ops (recorded by domain/auth/ when integrated; Slice 1+) ===
  | 'admin_credential_issue'
  | 'admin_credential_rotate'
  | 'admin_credential_revoke'
  | 'admin_signing_key_rotate'
  | 'admin_hivekeeper_create'
  | 'admin_hivekeeper_revoke'
  | 'admin_hivekeeper_admin_grant'
  | 'admin_hivekeeper_admin_revoke'
  | 'admin_agent_create'
  | 'admin_agent_revoke'
  | 'admin_agent_type_change'
  | 'admin_agent_suspend'
  | 'admin_agent_resume'
  // === Cell Store admin ops (recorded by domain/cells/ when integrated) ===
  | 'admin_retention_policy_set'
  | 'admin_retention_policy_clear'
  | 'admin_purge_run'
  // === Notifications (Waggle) ===
  | 'waggle_push_suppressed';

export type AuditEventDecision = 'allow' | 'deny' | 'success' | 'failure';

export type AuditActorKind = 'hivekeeper' | 'worker' | 'scout' | 'system';

export type AuditSubjectKind =
  | 'participant'
  | 'credential'
  | 'policy'
  | 'cell'
  | 'signing_key'
  | 'audit_log_range';

/** All audit event categories as an ordered tuple — used by tests for exhaustivity checks. */
export const ALL_AUDIT_EVENT_CATEGORIES: readonly AuditEventCategory[] = [
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
] as const;
