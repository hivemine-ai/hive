// Cross-spec domain types published by Cell Store + Message Persistence.
// Per the tech spec: tech specs hermanas (Visibility, Waggle, API MCP — Tools)
// import these from here — they do NOT redefine them.

import type { UUIDv7, Duration, IdentityContext } from '#domain/auth/types.js';

export type MessageType = 'request' | 'response' | 'notification';
export type MessageState = 'sent' | 'delivered' | 'read' | 'expired';
export type CellState = 'active' | 'closed';

export type ActionDescriptor = { [key: string]: unknown };

/**
 * The view of a Message exposed to consumers (readMailbox responses, MCP wire shapes).
 * `expiredAt` is intentionally omitted — clients never see expired messages, so the
 * column has no place in the consumer-facing view.
 */
export interface MessageView {
  id: UUIDv7;
  from: UUIDv7;
  to: UUIDv7;
  type: MessageType;
  body: string;
  action: ActionDescriptor | null;
  replyTo: UUIDv7 | null;
  ttl: Duration | null;
  sentAt: Date;
  deliveredAt: Date;
  readAt: Date | null;
  state: MessageState;
}

/**
 * The Cell entity. Owns a participant 1-to-1. `hiveId` is included here (the schema
 * has `hive_id NOT NULL`) for keeper / policy paths even though the tech spec text
 * omits it from the cross-spec TS definition.
 */
export interface Cell {
  id: UUIDv7;
  hiveId: UUIDv7;
  ownerId: UUIDv7;
  ownerKind: 'hivekeeper' | 'agent';
  state: CellState;
  createdAt: Date;
  closedAt: Date | null;
}

/**
 * The full Message entity (DB-side). Includes `expiredAt` which is set by the
 * expiration job alongside `state = 'expired'`.
 */
export interface Message {
  id: UUIDv7;
  cellId: UUIDv7;
  fromParticipantId: UUIDv7;
  toParticipantId: UUIDv7;
  type: MessageType;
  body: string;
  action: ActionDescriptor | null;
  replyTo: UUIDv7 | null;
  ttl: Duration | null;
  sentAt: Date;
  deliveredAt: Date;
  readAt: Date | null;
  state: MessageState;
  expiredAt: Date | null;
}

export interface Pagination {
  cursor: { deliveredAt: Date; messageId: UUIDv7 } | null;
  limit: number;
}

export interface ReadMailboxFilter {
  unreadOnly?: boolean;
  // state/inReplyTo are cross-spec deltas (PRY-005 MCP); declared here as optional
  // to avoid breaking changes later, but listMessages does NOT filter on them in B0.
  state?: MessageState;
  types?: MessageType[];
  inReplyTo?: UUIDv7;
}

export interface ReadMailboxInput {
  callerContext: IdentityContext;
  filter?: ReadMailboxFilter;
  pagination?: Pagination;
}

export interface MarkReadInput {
  callerContext: IdentityContext;
  messageIds: UUIDv7[];
}

export interface MarkReadResult {
  marked: UUIDv7[];
  ignored: UUIDv7[];
}

export interface SendMessageInput {
  callerContext: IdentityContext;
  recipientId: UUIDv7;
  type: MessageType;
  body: string;
  action?: ActionDescriptor;
  replyTo?: UUIDv7;
  ttl?: Duration;
  idempotencyKey?: string;
}

export interface SendResult {
  messageId: UUIDv7;
  sentAt: Date;
  deliveredAt: Date;
  replayed: boolean;
}

export interface RetentionPolicy {
  unreadRetention: Duration | null;
  readRetention: Duration | null;
}
