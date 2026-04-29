// Cross-spec domain types published by Auth + Identity.
// Per the tech spec: tech specs hermanas (Cell Store, Visibility, Waggle, MCP, hivectl)
// import these from here — they do NOT redefine UUIDv7 or invent their own brandings.

import type { UUIDv7 } from '#persistence/schema.js';

export type { UUIDv7 };

// Duration in milliseconds. Lean for runtime simplicity (no ISO 8601 parsing in hot paths).
export type Duration = number;

export type ParticipantKind = 'hivekeeper' | 'worker' | 'scout';

// Note: 'suspended' applies only to Agents (workers/scouts).
// Hivekeepers transition between 'active' and 'revoked' only.
export type ParticipantState = 'active' | 'suspended' | 'revoked';

/**
 * The credential snapshot that travels in the JWT payload (signed at issuance).
 * Captured at issue time and never mutated; the verifier exposes it as informative.
 */
export interface CredentialSnapshot {
  capabilities?: string[];
  issuedAt: Date;
  credentialJti: UUIDv7;
  credentialKid: string;
}

/**
 * Current (live) state of the participant resolved from the DB at verify time.
 * Authoritative for authorization decisions (e.g. `isAdmin` is read from here, not the JWT).
 */
export interface CurrentParticipantState {
  state: 'active'; // by construction of the verifier (step 7); stored as 'active' always
  type?: 'worker' | 'scout';
  isAdmin?: boolean;
}

/**
 * Output of `verifier.verify()` — the resolved identity context that flows to handlers.
 */
export interface IdentityContext {
  participantId: UUIDv7;
  kind: ParticipantKind;
  hiveId: UUIDv7;
  /**
   * `hive.name` slug — loaded during `verifier.verify()` per ADR-015. Required
   * for the agent-reference disambiguation algorithm (`<agent>@<owner-local>.<hiveName>`).
   * Mutable per product spec: callers that mutate `hive.name` mid-session see
   * stale values until next verify; accepted operational risk for v0.1.
   */
  hiveName: string;
  colonyId: UUIDv7;
  ownerId?: UUIDv7; // present only when kind != 'hivekeeper'
  snapshot: CredentialSnapshot;
  current: CurrentParticipantState;
}

/**
 * Output of `issuer.issueCredential()` and `rotator.rotateCredential()`.
 */
export interface IssuedCredential {
  jti: UUIDv7;
  jwt: string; // compact JWT serialization
  expiresAt: Date;
  participantId: UUIDv7;
  kid: string;
}

/**
 * Metadata returned by `listCredentials()` — never includes the JWT itself.
 */
export interface CredentialMetadata {
  jti: UUIDv7;
  participantId: UUIDv7;
  participantKind: ParticipantKind;
  kid: string;
  issuedAt: Date;
  expiresAt: Date;
  isRevoked: boolean;
}
