// Waggle notification payload — the semantic shape that the MCP transport
// translates into the wire MCP event. Per the tech spec § "waggle/types.ts".

import type { UUIDv7 } from '#domain/auth/types.js';

/**
 * `online` = delivered via live-event consolidation;
 * `replay` = delivered at subscribe-time (post-connect / post-resume).
 *
 * Both kinds carry the same payload (the product spec does not distinguish
 * between returning from offline and returning from suspended at payload
 * level). The kind is included as metadata because the wire MCP layer may
 * map them to distinct signals if API MCP — Tools so decides.
 */
export type WaggleKind = 'online' | 'replay';

/**
 * Synthetic event the sender throttle feeds to the consolidator when a deferred wake
 * fires. It carries no message id or content, does not count as admitted, and never
 * leaves the domain.
 */
export interface DeferredWakeEvent {
  kind: 'deferred_wake';
  cellId: UUIDv7;
  recipientId: UUIDv7;
  fromParticipantId: UUIDv7;
  scheduledAt: Date;
}

export interface WaggleNotification {
  kind: WaggleKind;
  /**
   * Stable identity of the event: a pure function of (cellId, latestMessageId,
   * unreadCount). Same observable state, same id, so a client may drop an event whose
   * id it already processed. It promises nothing per message or per delivery.
   */
  eventId: string;
  /**
   * cellId of the recipient. v0.1 OSS has 1:1 between participant and Cell, so
   * cellId + recipientId are redundant; both are emitted for forward-compat
   * with future models where a participant may own multiple Cells.
   */
  cellId: UUIDv7;
  recipientId: UUIDv7;
  /**
   * Number of messages in `state='stored'` at emission time. Excludes
   * `expired` and `read`. Guaranteed >= 1 by contract: if it would be 0, no
   * Waggle is emitted ("empty Cell at replay/flush: do not emit").
   */
  unreadCount: number;
  /**
   * Admitted events the quiet window absorbed: >= 1 online, 0 on replay and when a
   * deferred wake opened the window. Internal: it never reaches the wire and is not
   * part of `eventId`.
   */
  coalescedCount: number;
  /**
   * Opaque identifiers of participants with at least one unread message in
   * the Cell at emission time. No explicit cap in v0.1.
   */
  senderIds: UUIDv7[];
  emittedAt: Date;
  /**
   * Internal Waggle ID (telemetry). NOT a dedup primitive: two Waggles with
   * the same content have distinct waggleIds. Clients MUST NOT use waggleId
   * to dedup — the at-least-once contract plus documented races (subscribe +
   * messageStored + replay in flight, double-flush on window race) can
   * deliver multiple notifications reflecting the same Cell state. A client that
   * dedups does it by `eventId`.
   */
  waggleId: UUIDv7;
}
