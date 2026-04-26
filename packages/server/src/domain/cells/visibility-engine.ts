// Contract for the Visibility Engine — implemented elsewhere (PRY-008).
//
// Lives in the Cell Store domain so that `cells/send.ts` and downstream consumers
// can depend on a neutral interface without reaching into the composition root.
// The composition root re-exports this same type from `composition/stubs.ts`
// (and will swap the stub for the real implementation when PRY-008 lands).
//
// The shape of the input objects (canSendInput / canSeeInput) follows the
// "structured argument" convention agreed in the Visibility Engine + Audit Log
// tech spec — every field travels by name so sites that pass `requestId` for
// audit correlation never get parameter-position bugs.

import type { IdentityContext, UUIDv7 } from '#domain/auth/types.js';

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

export interface VisibilityEngine {
  canSend(input: CanSendInput): Promise<boolean>;
  canSee(input: CanSeeInput): Promise<boolean>;
}
