import type { MessageView } from '#domain/cells/index.js';

import { ensureSafeAction, MAX_ACTION_DEPTH } from '../action-safety.js';

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
  from: string;
  to: string;
  type: 'request' | 'response' | 'notification';
  body: string;
  action: unknown;
  reply_to: string | null;
  ttl_ms: number | null;
  sent_at: string;
  delivered_at: string;
  read_at: string | null;
  state: 'sent' | 'delivered' | 'read' | 'expired';
}

export interface ReadMailboxWireOutput {
  messages: MessageViewWire[];
  next_cursor: { delivered_at: string; message_id: string } | null;
}

/** Adapt a single MessageView to wire form (with action depth re-check). */
export function adaptMessageView(message: MessageView): MessageViewWire {
  return {
    id: message.id,
    from: message.from,
    to: message.to,
    type: message.type,
    body: message.body,
    action: message.action !== null ? ensureSafeAction(message.action, MAX_ACTION_DEPTH) : null,
    reply_to: message.replyTo,
    ttl_ms: message.ttl,
    sent_at: message.sentAt.toISOString(),
    delivered_at: message.deliveredAt.toISOString(),
    read_at: message.readAt !== null ? message.readAt.toISOString() : null,
    state: message.state,
  };
}

/** Adapt the full mailbox response, including next-cursor derivation. */
export function adaptMailbox(messages: MessageView[], pageLimit: number): ReadMailboxWireOutput {
  const wireMessages = messages.map(adaptMessageView);
  const nextCursor =
    messages.length === pageLimit && messages.length > 0
      ? (() => {
          const last = messages[messages.length - 1];
          if (!last) return null;
          return {
            delivered_at: last.deliveredAt.toISOString(),
            message_id: last.id,
          };
        })()
      : null;
  return { messages: wireMessages, next_cursor: nextCursor };
}
