// `sendMessage` orchestrator for the Cell Store domain (PRY-003 + PRY-010 hardening).
//
// Responsibilities:
//   1. Validate input shape (body size, ttl, replyTo, idempotencyKey, action).
//   2. Idempotency lookup — replay-safe within the configured TTL.
//   3. Atomic TX: recipient cell guard (with FOR SHARE on PG) + visibility check
//      + INSERT messages + ON CONFLICT-protected idempotency_keys insert. The
//      cell guard runs INSIDE the TX (PRY-010 fix for the TOCTOU window between
//      the previous out-of-TX guard and the cascade closeCellsByOwner UPDATE).
//   4. Post-commit emit `messageDelivered` (best-effort — emit failure does NOT
//      rollback per tech spec line 408-409; per-listener errors funnel to
//      onEmitError, including async rejections from PRY-010 events refactor).
//
// Uniform privacy: the cell guard and the visibility check both collapse to the
// same wire error `RECIPIENT_UNREACHABLE`. The `subCode` is informative only
// (logged) and never reaches the wire — that's the API layer's responsibility.

import type { Kysely, Transaction } from 'kysely';
import { v7 as uuidv7, validate as uuidValidate, version as uuidVersion } from 'uuid';

import type { UUIDv7 } from '#domain/auth/types.js';
import type { Logger } from '#observability/logger.js';
import type { DbDialect } from '#persistence/db.js';
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
import type { VisibilityEngine } from '#domain/visibility/index.js';

// ---------- Public surface ----------

export interface SenderConfig {
  /** Default 65536 (64 KiB). */
  maxBodyBytes: number;
  /** Default 16384 (16 KiB) — applied to JSON.stringify(action). */
  maxActionBytes: number;
  /** Default 256 chars. */
  idempotencyKeyMaxLength: number;
  /**
   * DB dialect — controls whether the in-TX cell-guard SELECT emits `FOR SHARE`.
   *   - 'postgres': emits FOR SHARE so a concurrent `closeCellsByOwner` (which
   *     takes the implicit row exclusive lock on UPDATE) blocks the send until
   *     it commits, then the send observes `state='closed'` and aborts with
   *     RECIPIENT_UNREACHABLE.
   *   - 'sqlite': SQLite does not support FOR SHARE syntax. better-sqlite3
   *     serializes writes implicitly (single-writer), so the lock is unnecessary
   *     for correctness in OSS deployments.
   * Default: 'sqlite'.
   */
  dialect: DbDialect;
}

export const DEFAULT_SENDER_CONFIG: SenderConfig = {
  maxBodyBytes: 65536,
  maxActionBytes: 16384,
  idempotencyKeyMaxLength: 256,
  dialect: 'sqlite',
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
  /** Optional logger for happy-path observability (info-level events per ADR-013). */
  logger?: Logger;
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

  // PRY-025 / ADR-016: surface to operators that v0.1 OSS accepts `ttl_ms` for
  // forward-compat but does NOT enforce it. Per-instance flag so the info-level
  // event fires once per Sender (= once per process in production, since the
  // composition root creates a single Sender at startup) while remaining
  // testable (each test builds a fresh Sender with a fresh closure).
  let ttlNoEnforceWarningEmitted = false;

  async function idempotencyLookup(
    senderId: UUIDv7,
    recipientId: UUIDv7,
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
      .where('ik.recipient_id', '=', recipientId)
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
    recipientId: UUIDv7,
    key: string,
    messageId: UUIDv7,
  ): Promise<boolean> {
    const result = await tx
      .insertInto('idempotency_keys')
      .values({
        sender_id: senderId,
        recipient_id: recipientId,
        key,
        message_id: messageId,
      })
      .onConflict((oc) => oc.columns(['sender_id', 'recipient_id', 'key']).doNothing())
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

    // After validateTtl, `input.ttl !== undefined` implies `ttl > 0`. Surface
    // ADR-016 status once per process so operators relying on retention via
    // `ttl_ms` realise it has no effect in v0.1 OSS. Info level per ADR-013 —
    // this is documented status, not a recoverable anomaly.
    if (input.ttl !== undefined && !ttlNoEnforceWarningEmitted) {
      ttlNoEnforceWarningEmitted = true;
      deps.logger?.info(
        { event: 'cell_ttl_no_enforce' },
        'ttl_ms accepted but not enforced in v0.1 OSS per ADR-016. Effective retention is infinite. Implementation deferred to v0.2+.',
      );
    }

    const senderId = input.callerContext.participantId;

    // ── 2. idempotency lookup (best-effort early return) ──
    if (input.idempotencyKey !== undefined) {
      const existing = await idempotencyLookup(senderId, input.recipientId, input.idempotencyKey);
      if (existing) {
        return {
          messageId: existing.messageId,
          sentAt: existing.sentAt,
          deliveredAt: existing.deliveredAt,
          replayed: true,
        };
      }
    }

    const messageId = uuidv7();

    // ── 3. atomic TX: cell guard (FOR SHARE on PG) + visibility + insert + idempotency ──
    // The cell guard MUST run inside the TX so the SHARE lock blocks the send
    // until any in-flight cascade closeCellsByOwner UPDATE commits. After the
    // lock the SELECT either sees state='active' (proceed) or state='closed'
    // (abort). This closes the TOCTOU window flagged by PRY-003 /security-review.
    let resolvedCellId: UUIDv7 | null = null;
    let result: SendResult;
    try {
      result = await deps.db.transaction().execute(async (tx) => {
        const recipientCellRow = await selectRecipientCellLocked(
          tx,
          input.recipientId,
          config.dialect,
        );
        if (!recipientCellRow || recipientCellRow.state === 'closed') {
          throw new CellError('RECIPIENT_UNREACHABLE', { subCode: 'cell_closed_or_missing' });
        }

        const canSendInput: Parameters<typeof deps.visibilityEngine.canSend>[0] = {
          callerContext: input.callerContext,
          recipientId: input.recipientId,
          // Reuse the TX connection for the inner participants lookup. Required
          // for SQLite single-connection determinism (the outer `db` handle is
          // blocked while this TX is open). Postgres tolerates either; the
          // SQLite path is the gating constraint.
          executor: tx,
        };
        if (input.requestId !== undefined) canSendInput.requestId = input.requestId;
        const allowed = await deps.visibilityEngine.canSend(canSendInput);
        if (!allowed) {
          throw new CellError('RECIPIENT_UNREACHABLE', { subCode: 'visibility_denied' });
        }

        const message: Message = {
          id: messageId,
          cellId: recipientCellRow.id,
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

        await deps.cellsRepo.insertMessage(message, tx);
        if (input.idempotencyKey !== undefined) {
          const inserted = await insertIdempotencyKeyOrConflict(
            tx,
            senderId,
            input.recipientId,
            input.idempotencyKey,
            messageId,
          );
          if (!inserted) {
            // A concurrent send committed the same (sender_id, recipient_id, key) first.
            // Throw a sentinel to roll back our message INSERT and re-read
            // the winning row outside the TX.
            throw new IdempotencyConflictSentinel();
          }
        }

        resolvedCellId = recipientCellRow.id;
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
        const winning = await idempotencyLookup(
          senderId,
          input.recipientId,
          input.idempotencyKey as string,
        );
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

    // ── 4. post-commit emit (best-effort) ──
    // resolvedCellId is non-null when the TX commits without throwing.
    /* c8 ignore next 4 — defensive; only reachable on a TX success without cellId, which the type system rules out. */
    if (resolvedCellId === null) {
      throw new CellError('INTERNAL_INCONSISTENCY', { subCode: 'cell_id_unresolved' });
    }
    deps.events.emit(
      'messageDelivered',
      {
        messageId: result.messageId,
        cellId: resolvedCellId,
        recipientId: input.recipientId,
        fromParticipantId: senderId,
        type: input.type,
        deliveredAt: result.deliveredAt,
      },
      deps.onEmitError,
    );

    if (deps.logger && !result.replayed) {
      deps.logger.info(
        {
          event: 'cell_message_sent',
          messageId: result.messageId,
          cellId: resolvedCellId,
          fromParticipantId: senderId,
          recipientId: input.recipientId,
          type: input.type,
        },
        'cell message sent',
      );
    }

    return result;
  }

  return { sendMessage };
}

/**
 * SELECT id, state FROM cells WHERE owner_id = ? — locked variant.
 * On Postgres, takes a SHARE row lock so a concurrent UPDATE (closeCellsByOwner)
 * blocks until the send TX commits. On SQLite, the bare SELECT is sufficient
 * because better-sqlite3 serializes writes (single-writer model).
 */
async function selectRecipientCellLocked(
  tx: Transaction<Database>,
  recipientOwnerId: UUIDv7,
  dialect: DbDialect,
): Promise<{ id: UUIDv7; state: 'active' | 'closed' } | undefined> {
  let q = tx.selectFrom('cells').select(['id', 'state']).where('owner_id', '=', recipientOwnerId);
  if (dialect === 'postgres') {
    q = q.forShare();
  }
  return q.executeTakeFirst();
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
