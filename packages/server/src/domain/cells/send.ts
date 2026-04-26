// `sendMessage` orchestrator for the Cell Store domain (PRY-003).
//
// Responsibilities:
//   1. Validate input shape (body size, ttl, replyTo, idempotencyKey, action).
//   2. Idempotency lookup — replay-safe within the configured TTL.
//   3. Recipient cell guard (active Cell required).
//   4. Visibility check (`visibilityEngine.canSend`).
//   5. Build the Message + atomic INSERT (messages + idempotency_keys ON CONFLICT).
//   6. Post-commit emit `messageDelivered` (best-effort — emit failure does NOT
//      rollback per tech spec line 408-409).
//
// Privacidad uniforme: steps 3 and 4 collapse to the same wire error
// `RECIPIENT_UNREACHABLE`. The `subCode` is informative only (logged) and never
// reaches the wire — that's the responsibility of the API layer.

import type { Kysely, Transaction } from 'kysely';
import { v7 as uuidv7, validate as uuidValidate, version as uuidVersion } from 'uuid';

import type { UUIDv7 } from '#domain/auth/types.js';
import type { Database } from '#persistence/schema.js';

import { CellError } from './errors.js';
import type { CellEvents } from './events.js';
import type { CellsRepo } from './repository.js';
import type {
  ActionDescriptor,
  Message,
  MessageType,
  SendMessageInput,
  SendResult,
} from './types.js';
import type { VisibilityEngine } from './visibility-engine.js';

// ---------- Public surface ----------

export interface SenderConfig {
  /** Default 65536 (64 KiB). */
  maxBodyBytes: number;
  /** Default 16384 (16 KiB) — applied to JSON.stringify(action). */
  maxActionBytes: number;
  /** Default 256 chars. */
  idempotencyKeyMaxLength: number;
}

export const DEFAULT_SENDER_CONFIG: SenderConfig = {
  maxBodyBytes: 65536,
  maxActionBytes: 16384,
  idempotencyKeyMaxLength: 256,
};

export interface SenderDeps {
  cellsRepo: CellsRepo;
  visibilityEngine: VisibilityEngine;
  events: CellEvents;
  db: Kysely<Database>;
  /** Override defaults; missing keys fall back to {@link DEFAULT_SENDER_CONFIG}. */
  config?: Partial<SenderConfig>;
  /** Injectable clock for tests. Defaults to `new Date()`. */
  now?: () => Date;
  /** Optional sink for logger.warn-style diagnostics on emit failure. Default: silent. */
  onEmitError?: (err: unknown) => void;
}

export interface Sender {
  sendMessage(input: SendMessageInput): Promise<SendResult>;
}

// ---------- Implementation ----------

class IdempotencyConflictSentinel extends Error {
  constructor() {
    super('idempotency conflict — a concurrent send already persisted this key');
    this.name = 'IdempotencyConflictSentinel';
  }
}

interface IdempotencyHit {
  messageId: UUIDv7;
  sentAt: Date;
  deliveredAt: Date;
}

const VALID_TYPES: ReadonlyArray<MessageType> = ['request', 'response', 'notification'];

export function createSender(deps: SenderDeps): Sender {
  const config: SenderConfig = { ...DEFAULT_SENDER_CONFIG, ...(deps.config ?? {}) };
  const now = deps.now ?? (() => new Date());

  async function idempotencyLookup(
    senderId: UUIDv7,
    key: string,
    executor: Kysely<Database> | Transaction<Database> = deps.db,
  ): Promise<IdempotencyHit | null> {
    const row = await executor
      .selectFrom('idempotency_keys as ik')
      .innerJoin('messages as m', 'm.id', 'ik.message_id')
      .select([
        'ik.message_id as messageId',
        'm.sent_at as sentAt',
        'm.delivered_at as deliveredAt',
      ])
      .where('ik.sender_id', '=', senderId)
      .where('ik.key', '=', key)
      .executeTakeFirst();
    if (!row) return null;
    return {
      messageId: row.messageId,
      sentAt: new Date(row.sentAt),
      deliveredAt: new Date(row.deliveredAt),
    };
  }

  async function insertIdempotencyKeyOrConflict(
    tx: Transaction<Database>,
    senderId: UUIDv7,
    key: string,
    messageId: UUIDv7,
  ): Promise<boolean> {
    const result = await tx
      .insertInto('idempotency_keys')
      .values({
        sender_id: senderId,
        key,
        message_id: messageId,
      })
      .onConflict((oc) => oc.columns(['sender_id', 'key']).doNothing())
      .executeTakeFirst();
    return (result.numInsertedOrUpdatedRows ?? 0n) > 0n;
  }

  async function sendMessage(input: SendMessageInput): Promise<SendResult> {
    // ── 1. validate input shape ──
    validateBodySize(input.body, config.maxBodyBytes);
    validateType(input.type);
    validateReplyTo(input.replyTo);
    validateIdempotencyKey(input.idempotencyKey, config.idempotencyKeyMaxLength);
    validateAction(input.action, config.maxActionBytes);

    const sentAt = now();
    validateTtl(input.ttl, sentAt);

    const senderId = input.callerContext.participantId;

    // ── 2. idempotency lookup (best-effort early return) ──
    if (input.idempotencyKey !== undefined) {
      const existing = await idempotencyLookup(senderId, input.idempotencyKey);
      if (existing) {
        return {
          messageId: existing.messageId,
          sentAt: existing.sentAt,
          deliveredAt: existing.deliveredAt,
          replayed: true,
        };
      }
    }

    // ── 3. recipient cell guard ──
    const recipientCell = await deps.cellsRepo.findCellByOwner(input.recipientId);
    if (!recipientCell || recipientCell.state === 'closed') {
      throw new CellError('RECIPIENT_UNREACHABLE', { subCode: 'cell_closed_or_missing' });
    }

    // ── 4. visibility check (uniform privacy with step 3) ──
    const allowed = await deps.visibilityEngine.canSend({
      callerContext: input.callerContext,
      recipientId: input.recipientId,
    });
    if (!allowed) {
      throw new CellError('RECIPIENT_UNREACHABLE', { subCode: 'visibility_denied' });
    }

    // ── 5. build message ──
    const messageId = uuidv7();
    const message: Message = {
      id: messageId,
      cellId: recipientCell.id,
      fromParticipantId: senderId,
      toParticipantId: input.recipientId,
      type: input.type,
      body: input.body,
      action: input.action ?? null,
      replyTo: input.replyTo ?? null,
      ttl: input.ttl ?? null,
      sentAt,
      deliveredAt: sentAt,
      readAt: null,
      state: 'delivered',
      expiredAt: null,
    };

    // ── 6. atomic TX: insert message + idempotency key ──
    let result: SendResult;
    try {
      result = await deps.db.transaction().execute(async (tx) => {
        await deps.cellsRepo.insertMessage(message, tx);
        if (input.idempotencyKey !== undefined) {
          const inserted = await insertIdempotencyKeyOrConflict(
            tx,
            senderId,
            input.idempotencyKey,
            messageId,
          );
          if (!inserted) {
            // A concurrent send committed the same (sender_id, key) first.
            // Throw a sentinel to roll back our message INSERT and re-read
            // the winning row outside the TX.
            throw new IdempotencyConflictSentinel();
          }
        }
        return {
          messageId,
          sentAt,
          deliveredAt: sentAt,
          replayed: false,
        };
      });
    } catch (err) {
      if (err instanceof IdempotencyConflictSentinel) {
        // safe-cast: we only reach here if input.idempotencyKey was defined.
        const winning = await idempotencyLookup(senderId, input.idempotencyKey as string);
        if (!winning) {
          throw new CellError('INTERNAL_INCONSISTENCY', {
            subCode: 'idempotency_winner_missing',
          });
        }
        return {
          messageId: winning.messageId,
          sentAt: winning.sentAt,
          deliveredAt: winning.deliveredAt,
          replayed: true,
        };
      }
      throw err;
    }

    // ── 7. post-commit emit (best-effort) ──
    try {
      deps.events.emit('messageDelivered', {
        messageId: result.messageId,
        cellId: recipientCell.id,
        recipientId: input.recipientId,
        fromParticipantId: senderId,
        type: input.type,
        deliveredAt: result.deliveredAt,
      });
    } catch (err) {
      // Per tech spec: emit is best-effort. We do NOT rollback the INSERT.
      deps.onEmitError?.(err);
    }

    return result;
  }

  return { sendMessage };
}

// ---------- Validators ----------

function validateBodySize(body: string, maxBytes: number): void {
  // UTF-8 byte count, not JS string length — emoji etc. expand beyond 1 byte.
  const byteLength = Buffer.byteLength(body, 'utf8');
  if (byteLength > maxBytes) {
    throw new CellError('INVALID_INPUT', {
      subCode: 'body_too_large',
      message: `body byte length ${byteLength} exceeds maximum ${maxBytes}`,
    });
  }
}

function validateType(type: MessageType): void {
  // The TypeScript signature already constrains this; this guard is defensive
  // for callers that erase types at the wire boundary (MCP layer feeds us
  // the JSON-decoded `type` field directly).
  if (!VALID_TYPES.includes(type)) {
    throw new CellError('INVALID_INPUT', {
      subCode: 'type_unknown',
      message: `unknown message type: ${String(type)}`,
    });
  }
}

function validateReplyTo(replyTo: UUIDv7 | undefined): void {
  if (replyTo === undefined) return;
  if (!uuidValidate(replyTo) || uuidVersion(replyTo) !== 7) {
    throw new CellError('INVALID_INPUT', {
      subCode: 'reply_to_malformed',
      message: 'replyTo must be a UUID v7',
    });
  }
}

function validateIdempotencyKey(key: string | undefined, maxLength: number): void {
  if (key === undefined) return;
  if (key.length === 0) {
    throw new CellError('INVALID_INPUT', { subCode: 'idempotency_key_empty' });
  }
  if (key.length > maxLength) {
    throw new CellError('INVALID_INPUT', {
      subCode: 'idempotency_key_too_long',
      message: `idempotencyKey length ${key.length} exceeds maximum ${maxLength}`,
    });
  }
}

function validateAction(action: ActionDescriptor | undefined, maxBytes: number): void {
  if (action === undefined) return;
  const serialized = JSON.stringify(action);
  const byteLength = Buffer.byteLength(serialized, 'utf8');
  if (byteLength > maxBytes) {
    throw new CellError('INVALID_INPUT', {
      subCode: 'action_too_large',
      message: `action JSON byte length ${byteLength} exceeds maximum ${maxBytes}`,
    });
  }
}

function validateTtl(ttl: number | undefined, sentAt: Date): void {
  if (ttl === undefined) return;
  if (ttl <= 0) {
    throw new CellError('INVALID_INPUT', {
      subCode: 'ttl_invalid',
      message: 'ttl must be > 0 ms',
    });
  }
  // Per tech spec line 742 — ttl_in_past iff sentAt + ttl <= now. Since sentAt
  // IS now() at this point in the flow, this collapses to ttl <= 0; we still
  // honor the subCode separately so the API layer can surface either. Currently
  // unreachable in practice because validateTtl is only called with sentAt = now,
  // but kept for defense-in-depth and for the day callers can override sentAt.
  const expiresAt = sentAt.getTime() + ttl;
  if (expiresAt <= sentAt.getTime()) {
    /* c8 ignore next 4 — unreachable while sentAt = now() and ttl > 0. */
    throw new CellError('INVALID_INPUT', {
      subCode: 'ttl_in_past',
      message: 'sentAt + ttl falls in the past',
    });
  }
}
