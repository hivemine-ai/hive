// Event schema shared by every `hivectl watch` consumer. It is independent of
// the wire format: only three metadata fields exist, and nothing from a message
// (body, subject, free text) can ever reach a consumer through it.

import { randomUUID } from 'node:crypto';

export interface WatchEvent {
  /** Opaque id. `check:<UUID>` when the event comes from a query. */
  eventId: string;
  /** Opaque sender references with unread messages. */
  senders: string[];
  /** Unread messages in the mailbox at the time of the event. */
  count: number;
}

export interface UnreadSummary {
  count: number;
  senders: string[];
}

const MAX_ID_LENGTH = 128;
const MAX_SENDERS = 256;
// eslint-disable-next-line no-control-regex -- rejects control characters in opaque ids
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function isOpaqueId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    !CONTROL_CHARS.test(value)
  );
}

function parseSenders(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_SENDERS) return null;
  const out: string[] = [];
  for (const item of value as unknown[]) {
    if (!isOpaqueId(item)) return null;
    out.push(item);
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Maps the `_meta.hiveWaggle` payload of a `notifications/resources/updated`
 * notification (Envelope 1) to a {@link WatchEvent}. Returns `null` for any
 * payload with an invalid shape. `kind` is ignored on purpose: a replay and an
 * online event produce the same event.
 */
export function parseWaggleMeta(raw: unknown): WatchEvent | null {
  if (!isRecord(raw)) return null;
  const eventId = raw['event_id'];
  const count = raw['unread_count'];
  const senders = parseSenders(raw['sender_ids']);
  if (!isOpaqueId(eventId)) return null;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) return null;
  if (senders === null) return null;
  return { eventId, senders, count };
}

/** Parses the structured result of `check_unread_messages`. */
export function parseUnreadSummary(raw: unknown): UnreadSummary | null {
  if (!isRecord(raw)) return null;
  const count = raw['unread_count'];
  const senders = parseSenders(raw['sender_ids']);
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) return null;
  if (senders === null) return null;
  return { count, senders };
}

/** Builds the event for a query result; `null` when nothing is unread. */
export function buildQueryEvent(summary: UnreadSummary): WatchEvent | null {
  if (summary.count < 1) return null;
  return { eventId: `check:${randomUUID()}`, senders: [...summary.senders], count: summary.count };
}

/** Serializes an event as one JSON line, with the allowlisted fields only. */
export function serializeEventLine(event: WatchEvent): string {
  return JSON.stringify({ eventId: event.eventId, senders: event.senders, count: event.count });
}
