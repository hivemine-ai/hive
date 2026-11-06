import { ensureSafeAction, MAX_ACTION_DEPTH } from '#domain/cells/index.js';
import type { MessageView } from '#domain/cells/index.js';

/**
 * Wire shape of a Message — Date fields serialised as ISO 8601 UTC strings,
 * `from`/`to` opaque UUID v7 strings, `state` literal of MessageState. Per the
 * tech spec § Tool 3 read_mailbox.
 *
 * `action` is JSON serialised by Cell Store but kept opaque domain-side; this
 * view re-validates depth before exposing to the client (F-S3 hardening from
 * PRY-003 security review — see PRY-006 Notas).
 */
export interface MessageViewWire {
  id: string;
  /** The opaque id of the sender, or `system` for a notification of the Hive (ADR-026). */
  from: string;
  /** Present only on a notification of the Hive. */
  from_kind?: 'system';
  to: string;
  type: 'request' | 'response' | 'notification';
  body: string;
  action: unknown;
  reply_to: string | null;
  ttl_ms: number | null;
  sent_at: string;
  stored_at: string;
  read_at: string | null;
  state: 'sent' | 'stored' | 'read' | 'expired';
}

export interface ReadMailboxWireOutput {
  messages: MessageViewWire[];
  next_cursor: { stored_at: string; message_id: string } | null;
}

/** The sender label of a notification deposited by the Hive itself (`hives.id`). */
export const SYSTEM_SENDER = 'system';

/**
 * Adapt a single MessageView to wire form (with action depth re-check). A message
 * whose sender is `systemSenderId` (the Hive id) is rendered with the `system` label.
 */
export function adaptMessageView(message: MessageView, systemSenderId?: string): MessageViewWire {
  const fromSystem = systemSenderId !== undefined && message.from === systemSenderId;
  return {
    id: message.id,
    from: fromSystem ? SYSTEM_SENDER : message.from,
    ...(fromSystem && { from_kind: SYSTEM_SENDER }),
    to: message.to,
    type: message.type,
    body: message.body,
    action: message.action !== null ? ensureSafeAction(message.action, MAX_ACTION_DEPTH) : null,
    reply_to: message.replyTo,
    ttl_ms: message.ttl,
    sent_at: message.sentAt.toISOString(),
    stored_at: message.storedAt.toISOString(),
    read_at: message.readAt !== null ? message.readAt.toISOString() : null,
    state: message.state,
  };
}

/** Adapt the full mailbox response, including next-cursor derivation. */
export function adaptMailbox(
  messages: MessageView[],
  pageLimit: number,
  systemSenderId?: string,
): ReadMailboxWireOutput {
  const wireMessages = messages.map((message) => adaptMessageView(message, systemSenderId));
  const nextCursor =
    messages.length === pageLimit && messages.length > 0
      ? (() => {
          const last = messages[messages.length - 1];
          if (!last) return null;
          return {
            stored_at: last.storedAt.toISOString(),
            message_id: last.id,
          };
        })()
      : null;
  return { messages: wireMessages, next_cursor: nextCursor };
}
