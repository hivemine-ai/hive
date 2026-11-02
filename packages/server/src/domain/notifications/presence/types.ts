// Public types of the presence subsystem (re-exported from the notifications
// barrel). Per the tech spec § "presence/types.ts".

import type { IdentityContext, UUIDv7 } from '#domain/auth/types.js';

import type { StreamCloseReason, SubscriberHandle } from './subscriber-handle.js';

export interface SubscribeInput {
  callerContext: IdentityContext;
  /**
   * Handle provided by the MCP transport. Its lifecycle is bound to the stream
   * that created it: when the stream ends (graceful, disconnect, stall or a
   * forced `close()`), the handle invokes its `onClose()` and the registry
   * deregisters it.
   */
  handle: SubscriberHandle;
  /** Optional: requestId of the POST that opened the stream, for log correlation. */
  requestId?: string;
}

export interface Subscription {
  /** ID of this subscription. Distinct from the handle's `connectionId`. */
  readonly id: UUIDv7;
  readonly participantId: UUIDv7;
  readonly subscribedAt: Date;
  /**
   * The transport calls this ONCE right after writing the `subscriptions/listen`
   * acknowledgment. It flips the entry from `pending` to `open` (counts as
   * online, receives fan-out) and triggers the replay. Idempotent.
   */
  ready(): void;
  /**
   * Removes the entry with `reason` (default `client_closed`). Does NOT close
   * the physical stream. Idempotent.
   */
  close(reason?: StreamCloseReason): void;
}

export interface PresenceSnapshot {
  /** Reachable by push: at least one `open` stream that subscribes the own mailbox. */
  online: boolean;
  /** Number of `open` streams. */
  streamCount: number;
  /**
   * When each open stream registered. Provided internally; the wire tool
   * `get_agent_status` intentionally does not expose these timestamps.
   */
  streamsSubscribedAt: readonly Date[];
}
