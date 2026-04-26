// Public types of the presence subsystem (re-exported from the notifications
// barrel). Per the tech spec § "presence/types.ts".

import type { IdentityContext, UUIDv7 } from '#domain/auth/types.js';

import type { SubscriberHandle } from './subscriber-handle.js';

export interface SubscribeInput {
  callerContext: IdentityContext;
  /**
   * Handle provided by the MCP transport. Its lifecycle is bound to the MCP
   * session that created it: when the session closes (graceful or disconnect),
   * the handle invokes its `onClose()` and the registry deregisters it.
   */
  handle: SubscriberHandle;
  /** Optional: requestId for cross-component log correlation. */
  requestId?: string;
}

export interface Subscription {
  /**
   * ID of this subscription. Distinct from the handle's `connectionId` —
   * a handle may resubscribe (e.g. after a resume) and obtain a new
   * subscriptionId.
   */
  readonly id: UUIDv7;
  readonly participantId: UUIDv7;
  readonly subscribedAt: Date;
  /** Idempotent: closing twice is a no-op. */
  close(): void;
}

export interface PresenceSnapshot {
  online: boolean;
  sessionCount: number;
  /**
   * Timestamps of when each active session established its subscribe. The
   * decision of whether to expose these on the wire belongs to API MCP — Tools.
   */
  sessionsSubscribedAt: readonly Date[];
}
