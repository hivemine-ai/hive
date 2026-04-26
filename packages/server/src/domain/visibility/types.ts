// Public types of the Visibility Engine.
// Canonical home of the `VisibilityEngine` contract per the tech spec —
// previously placed in `domain/cells/visibility-engine.ts` as a placeholder
// while PRY-003 shipped without the real engine. This file is the single
// source of truth; `cells/` consumes it via `#domain/visibility/index.js`.

import type { IdentityContext, ParticipantKind, UUIDv7 } from '#domain/auth/types.js';

export interface CanSendInput {
  callerContext: IdentityContext;
  recipientId: UUIDv7;
  /** Optional correlation id propagated to the audit log when the engine logs. */
  requestId?: string;
}

export interface CanSeeInput {
  callerContext: IdentityContext;
  targetId: UUIDv7;
  requestId?: string;
}

/**
 * Public contract consumed by Cell Store (sendMessage) and the future MCP
 * directory (`list_agents`). Inputs are structured (not positional) — fields
 * travel by name so call sites that pass `requestId` for audit correlation
 * never get parameter-position bugs.
 *
 * `canSend` returns boolean; ANY false (sender vs recipient prohibited,
 * recipient inexistent, cross-Hive) collapses to the same boolean — Cell Store
 * maps any `false` to its wire error `RECIPIENT_UNREACHABLE` (uniform privacy).
 */
export interface VisibilityEngine {
  canSend(input: CanSendInput): Promise<boolean>;
  canSee(input: CanSeeInput): Promise<boolean>;
}

/**
 * Class of the sender as evaluated by the matrix. Derived from
 * `IdentityContext.kind` and (for agents) `current.type`.
 */
export type SenderClass = 'hivekeeper' | 'worker' | 'scout';

/**
 * Class of the recipient relative to the sender. Derived by
 * `classifyRecipient(callerContext, recipient)`.
 *
 * `'self'` matches when sender and recipient are the same participant id.
 */
export type RecipientClass =
  | 'own_worker'
  | 'own_scout'
  | 'other_owner_worker'
  | 'other_owner_scout'
  | 'own_hivekeeper'
  | 'other_hivekeeper'
  | 'self';

/**
 * Internal denial reason — written to the audit log as `reason_code`, never to
 * the wire (privacy uniformity per tech spec — security considerations).
 */
export type DenialReason =
  | 'recipient_not_found'
  | 'cross_hive'
  | 'worker_to_other_owner_worker'
  | 'worker_to_other_hivekeeper'
  | 'scout_to_other_owner_worker'
  | 'hivekeeper_to_other_owner_worker'
  | 'unmapped_combination';

/** Resolved participant snapshot consumed by `classifyRecipient`. */
export interface ResolvedRecipient {
  id: UUIDv7;
  kind: ParticipantKind;
  /** Present only for agents (worker / scout). */
  type?: 'worker' | 'scout';
  /** Present only for agents — the owner Hivekeeper id. */
  ownerId?: UUIDv7;
  hiveId: UUIDv7;
}
