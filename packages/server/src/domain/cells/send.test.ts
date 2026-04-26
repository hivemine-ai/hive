import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { v7 as uuidv7 } from 'uuid';

import type { Kysely } from 'kysely';

import type { IdentityContext, UUIDv7 } from '#domain/auth/types.js';
import { createDb } from '#persistence/db.js';
import { migrateToLatest } from '#persistence/migrate.js';
import type { Database } from '#persistence/schema.js';

import { CellError, isCellError } from './errors.js';
import { createCellEvents } from './events.js';
import type { CellEvents, MessageDeliveredEvent } from './events.js';
import { createCellsRepo } from './repository.js';
import type { CellsRepo } from './repository.js';
import { createSender } from './send.js';
import type { Sender, SenderConfig } from './send.js';
import type { VisibilityEngine } from './visibility-engine.js';

interface SendWorld {
  db: Kysely<Database>;
  cellsRepo: CellsRepo;
  events: CellEvents;
  hiveId: UUIDv7;
  colonyId: UUIDv7;
  hkA: UUIDv7;
  hkB: UUIDv7;
  workerA: UUIDv7;
  workerB: UUIDv7;
  cellA: UUIDv7;
  cellB: UUIDv7;
}

async function seedSendWorld(): Promise<SendWorld> {
  const db = createDb({ dialect: 'sqlite', url: 'sqlite::memory:' });
  await migrateToLatest(db);

  const hiveId = uuidv7();
  const colonyId = uuidv7();
  const hkA = uuidv7();
  const hkB = uuidv7();
  const workerA = uuidv7();
  const workerB = uuidv7();

  await db.insertInto('hives').values({ id: hiveId, name: 'Send Test Hive' }).execute();
  await db
    .insertInto('colonies')
    .values({ id: colonyId, hive_id: hiveId, name: 'default' })
    .execute();

  for (const [id, email] of [
    [hkA, 'a@example.com'],
    [hkB, 'b@example.com'],
  ] as const) {
    await db
      .insertInto('hivekeepers')
      .values({
        id,
        hive_id: hiveId,
        colony_id: colonyId,
        email,
        display_name: null,
        is_admin: 1,
        state: 'active',
        revoked_at: null,
      })
      .execute();
  }

  for (const [id, name] of [
    [workerA, 'worker-a'],
    [workerB, 'worker-b'],
  ] as const) {
    await db
      .insertInto('agents')
      .values({
        id,
        hive_id: hiveId,
        colony_id: colonyId,
        owner_id: hkA,
        name,
        type: 'worker',
        capabilities: '[]',
        instructions: '',
        state: 'active',
        revoked_at: null,
      })
      .execute();
  }

  const cellsRepo = createCellsRepo(db);
  const cellA = await cellsRepo.createCell({
    ownerId: workerA,
    ownerKind: 'agent',
    hiveId,
  });
  const cellB = await cellsRepo.createCell({
    ownerId: workerB,
    ownerKind: 'agent',
    hiveId,
  });

  return {
    db,
    cellsRepo,
    events: createCellEvents(),
    hiveId,
    colonyId,
    hkA,
    hkB,
    workerA,
    workerB,
    cellA: cellA.id,
    cellB: cellB.id,
  };
}

function buildContext(world: SendWorld, participantId: UUIDv7): IdentityContext {
  return {
    participantId,
    kind: 'worker',
    hiveId: world.hiveId,
    colonyId: world.colonyId,
    ownerId: world.hkA,
    snapshot: {
      issuedAt: new Date('2026-04-26T09:00:00.000Z'),
      credentialJti: uuidv7(),
      credentialKid: 'kid-test',
    },
    current: { state: 'active', type: 'worker' },
  };
}

const ALWAYS_ALLOW: VisibilityEngine = {
  canSend: () => Promise.resolve(true),
  canSee: () => Promise.resolve(true),
};

const ALWAYS_DENY: VisibilityEngine = {
  canSend: () => Promise.resolve(false),
  canSee: () => Promise.resolve(false),
};

interface SenderHarness {
  sender: Sender;
  visibility: VisibilityEngine;
}

function buildSender(
  world: SendWorld,
  options: {
    visibility?: VisibilityEngine;
    config?: Partial<SenderConfig>;
    now?: () => Date;
    onEmitError?: (err: unknown) => void;
  } = {},
): SenderHarness {
  const visibility = options.visibility ?? ALWAYS_ALLOW;
  const sender = createSender({
    cellsRepo: world.cellsRepo,
    visibilityEngine: visibility,
    events: world.events,
    db: world.db,
    ...(options.config !== undefined ? { config: options.config } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.onEmitError !== undefined ? { onEmitError: options.onEmitError } : {}),
  });
  return { sender, visibility };
}

describe('createSender / sendMessage', () => {
  let world: SendWorld;

  beforeEach(async () => {
    world = await seedSendWorld();
  });

  afterEach(async () => {
    await world.db.destroy();
  });

  describe('happy path', () => {
    it('persists the message and emits messageDelivered post-commit', async () => {
      const at = new Date('2026-04-26T10:00:00.000Z');
      const { sender } = buildSender(world, { now: () => at });
      const events: MessageDeliveredEvent[] = [];
      world.events.on('messageDelivered', (e) => events.push(e));

      const result = await sender.sendMessage({
        callerContext: buildContext(world, world.workerA),
        recipientId: world.workerB,
        type: 'request',
        body: 'hello',
      });

      expect(result.replayed).toBe(false);
      expect(result.messageId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(result.sentAt.getTime()).toBe(at.getTime());
      expect(result.deliveredAt.getTime()).toBe(at.getTime());

      const persisted = await world.db
        .selectFrom('messages')
        .selectAll()
        .where('id', '=', result.messageId)
        .executeTakeFirst();
      expect(persisted).toBeDefined();
      expect(persisted?.cell_id).toBe(world.cellB);
      expect(persisted?.from_participant_id).toBe(world.workerA);
      expect(persisted?.to_participant_id).toBe(world.workerB);
      expect(persisted?.state).toBe('delivered');
      expect(persisted?.body).toBe('hello');
      expect(persisted?.action).toBeNull();

      expect(events.length).toBe(1);
      expect(events[0]).toMatchObject({
        messageId: result.messageId,
        cellId: world.cellB,
        recipientId: world.workerB,
        fromParticipantId: world.workerA,
        type: 'request',
      });
      expect(events[0]?.deliveredAt.getTime()).toBe(at.getTime());
    });

    it('serializes the action descriptor as JSON', async () => {
      const { sender } = buildSender(world);
      const result = await sender.sendMessage({
        callerContext: buildContext(world, world.workerA),
        recipientId: world.workerB,
        type: 'request',
        body: 'do x',
        action: { kind: 'demo', payload: { n: 1 } },
      });
      const row = await world.db
        .selectFrom('messages')
        .select(['action'])
        .where('id', '=', result.messageId)
        .executeTakeFirst();
      expect(row?.action).toBe(JSON.stringify({ kind: 'demo', payload: { n: 1 } }));
    });

    it('persists optional fields (replyTo, ttl) when provided', async () => {
      const { sender } = buildSender(world);
      const replyTo = uuidv7();
      const result = await sender.sendMessage({
        callerContext: buildContext(world, world.workerA),
        recipientId: world.workerB,
        type: 'response',
        body: 'reply',
        replyTo,
        ttl: 60_000,
      });
      const row = await world.db
        .selectFrom('messages')
        .select(['reply_to', 'ttl_ms'])
        .where('id', '=', result.messageId)
        .executeTakeFirst();
      expect(row?.reply_to).toBe(replyTo);
      expect(row?.ttl_ms).toBe(60_000);
    });
  });

  describe('INVALID_INPUT validations', () => {
    it('body_too_large: rejects body above the configured byte limit (no DB write)', async () => {
      const { sender } = buildSender(world, { config: { maxBodyBytes: 65536 } });
      const oversized = 'a'.repeat(65537);
      await expect(
        sender.sendMessage({
          callerContext: buildContext(world, world.workerA),
          recipientId: world.workerB,
          type: 'request',
          body: oversized,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT', subCode: 'body_too_large' });
      const count = await world.db
        .selectFrom('messages')
        .select((eb) => eb.fn.countAll().as('n'))
        .executeTakeFirst();
      expect(Number(count?.n ?? 0)).toBe(0);
    });

    it('body_too_large: counts UTF-8 bytes, not JS string length', async () => {
      // 'é' is 2 bytes in UTF-8 — 'éé' = 4 bytes, exceeds maxBodyBytes=3 → fail.
      const { sender } = buildSender(world, { config: { maxBodyBytes: 3 } });
      await expect(
        sender.sendMessage({
          callerContext: buildContext(world, world.workerA),
          recipientId: world.workerB,
          type: 'request',
          body: 'éé', // 4 bytes
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT', subCode: 'body_too_large' });
    });

    it('ttl_invalid: ttl <= 0 throws', async () => {
      const { sender } = buildSender(world);
      for (const ttl of [0, -1, -100]) {
        await expect(
          sender.sendMessage({
            callerContext: buildContext(world, world.workerA),
            recipientId: world.workerB,
            type: 'request',
            body: 'x',
            ttl,
          }),
        ).rejects.toMatchObject({ code: 'INVALID_INPUT', subCode: 'ttl_invalid' });
      }
    });

    it('reply_to_malformed: non-UUID v7 string throws', async () => {
      const { sender } = buildSender(world);
      await expect(
        sender.sendMessage({
          callerContext: buildContext(world, world.workerA),
          recipientId: world.workerB,
          type: 'response',
          body: 'r',
          replyTo: 'not-a-uuid',
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT', subCode: 'reply_to_malformed' });

      // A v4 UUID is valid syntactically but wrong version.
      await expect(
        sender.sendMessage({
          callerContext: buildContext(world, world.workerA),
          recipientId: world.workerB,
          type: 'response',
          body: 'r',
          replyTo: '11111111-1111-4111-8111-111111111111',
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT', subCode: 'reply_to_malformed' });
    });

    it('idempotency_key_too_long: > maxLength throws', async () => {
      const { sender } = buildSender(world, { config: { idempotencyKeyMaxLength: 256 } });
      await expect(
        sender.sendMessage({
          callerContext: buildContext(world, world.workerA),
          recipientId: world.workerB,
          type: 'request',
          body: 'x',
          idempotencyKey: 'k'.repeat(257),
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT', subCode: 'idempotency_key_too_long' });
    });

    it('idempotency_key_empty: empty string throws', async () => {
      const { sender } = buildSender(world);
      await expect(
        sender.sendMessage({
          callerContext: buildContext(world, world.workerA),
          recipientId: world.workerB,
          type: 'request',
          body: 'x',
          idempotencyKey: '',
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT', subCode: 'idempotency_key_empty' });
    });

    it('action_too_large: serialized action above maxActionBytes throws', async () => {
      const { sender } = buildSender(world, { config: { maxActionBytes: 16384 } });
      // ASCII payload — 1 byte per char inside the JSON string + overhead.
      const big = 'a'.repeat(16400);
      await expect(
        sender.sendMessage({
          callerContext: buildContext(world, world.workerA),
          recipientId: world.workerB,
          type: 'request',
          body: 'x',
          action: { payload: big },
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT', subCode: 'action_too_large' });
    });

    it('type_unknown: defensive runtime guard for callers that erase types', async () => {
      const { sender } = buildSender(world);
      await expect(
        sender.sendMessage({
          callerContext: buildContext(world, world.workerA),
          recipientId: world.workerB,
          // Force the bad value through the type system at the boundary.
          type: 'invalid' as unknown as 'request',
          body: 'x',
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT', subCode: 'type_unknown' });
    });
  });

  describe('RECIPIENT_UNREACHABLE (uniform privacy)', () => {
    it('cell_closed_or_missing: recipient has no Cell', async () => {
      const { sender } = buildSender(world);
      await expect(
        sender.sendMessage({
          callerContext: buildContext(world, world.workerA),
          recipientId: uuidv7(),
          type: 'request',
          body: 'x',
        }),
      ).rejects.toMatchObject({
        code: 'RECIPIENT_UNREACHABLE',
        subCode: 'cell_closed_or_missing',
      });
    });

    it('cell_closed_or_missing: recipient Cell is closed', async () => {
      await world.cellsRepo.closeCell({ ownerId: world.workerB });
      const { sender } = buildSender(world);
      await expect(
        sender.sendMessage({
          callerContext: buildContext(world, world.workerA),
          recipientId: world.workerB,
          type: 'request',
          body: 'x',
        }),
      ).rejects.toMatchObject({
        code: 'RECIPIENT_UNREACHABLE',
        subCode: 'cell_closed_or_missing',
      });
    });

    it('visibility_denied: same wire code, different subCode', async () => {
      const { sender } = buildSender(world, { visibility: ALWAYS_DENY });
      await expect(
        sender.sendMessage({
          callerContext: buildContext(world, world.workerA),
          recipientId: world.workerB,
          type: 'request',
          body: 'x',
        }),
      ).rejects.toMatchObject({
        code: 'RECIPIENT_UNREACHABLE',
        subCode: 'visibility_denied',
      });
    });

    it('does not write to messages on either failure path', async () => {
      const { sender } = buildSender(world, { visibility: ALWAYS_DENY });
      try {
        await sender.sendMessage({
          callerContext: buildContext(world, world.workerA),
          recipientId: world.workerB,
          type: 'request',
          body: 'x',
        });
      } catch (err) {
        expect(isCellError(err)).toBe(true);
      }
      const count = await world.db
        .selectFrom('messages')
        .select((eb) => eb.fn.countAll().as('n'))
        .executeTakeFirst();
      expect(Number(count?.n ?? 0)).toBe(0);
    });
  });

  describe('idempotency', () => {
    it('replay returns the same messageId with replayed=true; only one message persists', async () => {
      const { sender } = buildSender(world);
      const ctx = buildContext(world, world.workerA);
      const idempotencyKey = 'client-key-abc';

      const first = await sender.sendMessage({
        callerContext: ctx,
        recipientId: world.workerB,
        type: 'request',
        body: 'x',
        idempotencyKey,
      });
      expect(first.replayed).toBe(false);

      const second = await sender.sendMessage({
        callerContext: ctx,
        recipientId: world.workerB,
        type: 'request',
        body: 'x',
        idempotencyKey,
      });
      expect(second.replayed).toBe(true);
      expect(second.messageId).toBe(first.messageId);
      expect(second.sentAt.getTime()).toBe(first.sentAt.getTime());
      expect(second.deliveredAt.getTime()).toBe(first.deliveredAt.getTime());

      const count = await world.db
        .selectFrom('messages')
        .select((eb) => eb.fn.countAll().as('n'))
        .executeTakeFirst();
      expect(Number(count?.n ?? 0)).toBe(1);
    });

    it('different idempotency keys produce independent messages', async () => {
      const { sender } = buildSender(world);
      const ctx = buildContext(world, world.workerA);
      const a = await sender.sendMessage({
        callerContext: ctx,
        recipientId: world.workerB,
        type: 'request',
        body: '1',
        idempotencyKey: 'k1',
      });
      const b = await sender.sendMessage({
        callerContext: ctx,
        recipientId: world.workerB,
        type: 'request',
        body: '2',
        idempotencyKey: 'k2',
      });
      expect(a.messageId).not.toBe(b.messageId);
      expect(a.replayed).toBe(false);
      expect(b.replayed).toBe(false);
    });

    it('different senders may share the same key without colliding', async () => {
      const { sender } = buildSender(world);
      const a = await sender.sendMessage({
        callerContext: buildContext(world, world.workerA),
        recipientId: world.workerB,
        type: 'request',
        body: '1',
        idempotencyKey: 'shared-key',
      });
      const b = await sender.sendMessage({
        callerContext: buildContext(world, world.workerB),
        recipientId: world.workerA,
        type: 'request',
        body: '2',
        idempotencyKey: 'shared-key',
      });
      expect(a.messageId).not.toBe(b.messageId);
      expect(a.replayed).toBe(false);
      expect(b.replayed).toBe(false);
    });

    it('detects a concurrent winner: pre-seeded idempotency_keys collapses to replayed=true', async () => {
      const { sender } = buildSender(world);
      const ctx = buildContext(world, world.workerA);
      const idempotencyKey = 'concurrent-race';

      // Simulate "another request committed first": directly insert a message
      // + an idempotency_keys row owned by workerA for `idempotencyKey`.
      const winningMessageId = uuidv7();
      const winningSentAt = new Date('2026-04-26T09:30:00.000Z');
      await world.cellsRepo.insertMessage({
        id: winningMessageId,
        cellId: world.cellB,
        fromParticipantId: world.workerA,
        toParticipantId: world.workerB,
        type: 'request',
        body: 'pre-existing',
        action: null,
        replyTo: null,
        ttl: null,
        sentAt: winningSentAt,
        deliveredAt: winningSentAt,
        readAt: null,
        state: 'delivered',
        expiredAt: null,
      });
      await world.db
        .insertInto('idempotency_keys')
        .values({
          sender_id: world.workerA,
          key: idempotencyKey,
          message_id: winningMessageId,
        })
        .execute();

      const result = await sender.sendMessage({
        callerContext: ctx,
        recipientId: world.workerB,
        type: 'request',
        body: 'second-attempt',
        idempotencyKey,
      });
      expect(result.replayed).toBe(true);
      expect(result.messageId).toBe(winningMessageId);

      // Only the pre-seeded message remains.
      const rows = await world.db.selectFrom('messages').selectAll().execute();
      expect(rows.length).toBe(1);
      expect(rows[0]?.id).toBe(winningMessageId);
    });
  });

  describe('post-commit emit', () => {
    it('emits AFTER the row is visible to a reader', async () => {
      const { sender } = buildSender(world);
      const observedRowAtEmit: Array<unknown> = [];
      world.events.on('messageDelivered', (e) => {
        // Synchronous read inside the listener — the only reason this is safe
        // here is that better-sqlite3 is synchronous under Kysely's facade.
        // The point of the test is the *ordering* contract: the listener fires
        // strictly after commit, so a fresh SELECT on the same connection MUST
        // see the row.
        const promise = world.db
          .selectFrom('messages')
          .select(['id'])
          .where('id', '=', e.messageId)
          .executeTakeFirst();
        observedRowAtEmit.push(promise);
      });

      const result = await sender.sendMessage({
        callerContext: buildContext(world, world.workerA),
        recipientId: world.workerB,
        type: 'notification',
        body: 'hi',
      });
      const [row] = await Promise.all(observedRowAtEmit as Array<Promise<unknown>>);
      expect(row).toBeDefined();
      expect((row as { id: string }).id).toBe(result.messageId);
    });

    it('does NOT rollback the INSERT when a listener throws (best-effort emit)', async () => {
      const onEmitError = vi.fn();
      const { sender } = buildSender(world, { onEmitError });
      world.events.on('messageDelivered', () => {
        throw new Error('boom — subscriber blew up');
      });

      const result = await sender.sendMessage({
        callerContext: buildContext(world, world.workerA),
        recipientId: world.workerB,
        type: 'request',
        body: 'persist me anyway',
      });

      const row = await world.db
        .selectFrom('messages')
        .selectAll()
        .where('id', '=', result.messageId)
        .executeTakeFirst();
      expect(row).toBeDefined();
      expect(onEmitError).toHaveBeenCalledTimes(1);
      expect(onEmitError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    });
  });

  describe('CellError shape', () => {
    it('throws CellError instances (not plain Error)', async () => {
      const { sender } = buildSender(world);
      await expect(
        sender.sendMessage({
          callerContext: buildContext(world, world.workerA),
          recipientId: uuidv7(),
          type: 'request',
          body: 'x',
        }),
      ).rejects.toBeInstanceOf(CellError);
    });
  });

  // PRY-010 hardening — concurrent send/cascade and concurrent same-key sends.
  describe('concurrency (PRY-010)', () => {
    it('TOCTOU send vs closeCellsByOwner: deterministic winner, no orphan messages', async () => {
      // SQLite serializes writes (single-writer); the test still validates the
      // post-conditions of the contract — never observes a message in a closed cell.
      // Postgres validation deferred (PRY risk #3).
      const { sender } = buildSender(world);

      const sendOp = sender
        .sendMessage({
          callerContext: buildContext(world, world.workerA),
          recipientId: world.workerB,
          type: 'request',
          body: 'racing',
        })
        .then(
          (r) => ({ kind: 'sent' as const, messageId: r.messageId }),
          (e: unknown) => ({ kind: 'failed' as const, error: e }),
        );

      const closeOp = world.cellsRepo
        .closeCellsByOwner([world.workerB])
        .then((r) => ({ kind: 'closed' as const, ids: r.closedCellIds }));

      const [sendOutcome, closeOutcome] = await Promise.all([sendOp, closeOp]);

      // Close always succeeds (idempotent atomic UPDATE).
      expect(closeOutcome.kind).toBe('closed');

      // The cell must be closed afterwards.
      const cellAfter = await world.cellsRepo.findCellByOwner(world.workerB);
      expect(cellAfter?.state).toBe('closed');

      // The send either won (message exists) or lost (RECIPIENT_UNREACHABLE).
      // It MUST NOT result in an orphan message addressed to the (now) closed cell
      // beyond a single legitimate row from a winning send.
      const messages = await world.db
        .selectFrom('messages')
        .selectAll()
        .where('cell_id', '=', world.cellB)
        .execute();

      if (sendOutcome.kind === 'sent') {
        // Send won the race → exactly one message; the cascade ran after the send committed.
        expect(messages.length).toBe(1);
        expect(messages[0]?.id).toBe(sendOutcome.messageId);
      } else {
        // Send lost the race → cell already closed when the in-TX guard ran.
        expect(messages.length).toBe(0);
        expect(sendOutcome.error).toBeInstanceOf(CellError);
        expect((sendOutcome.error as CellError).code).toBe('RECIPIENT_UNREACHABLE');
      }
    });

    it('two concurrent sendMessage with the same idempotencyKey: 1 row, exactly one replayed', async () => {
      const { sender } = buildSender(world);
      const ctx = buildContext(world, world.workerA);
      const idempotencyKey = `racer-${uuidv7()}`;

      const [first, second] = await Promise.all([
        sender.sendMessage({
          callerContext: ctx,
          recipientId: world.workerB,
          type: 'request',
          body: 'idempotent racer',
          idempotencyKey,
        }),
        sender.sendMessage({
          callerContext: ctx,
          recipientId: world.workerB,
          type: 'request',
          body: 'idempotent racer',
          idempotencyKey,
        }),
      ]);

      // Same canonical messageId returned to both callers.
      expect(first.messageId).toBe(second.messageId);

      // Exactly one is the original send, the other is the replay.
      const replayedFlags = [first.replayed, second.replayed].sort();
      expect(replayedFlags).toEqual([false, true]);

      // DB has exactly 1 message row + 1 idempotency row (sentinel rollback worked).
      const messageRows = await world.db
        .selectFrom('messages')
        .selectAll()
        .where('id', '=', first.messageId)
        .execute();
      expect(messageRows.length).toBe(1);

      const idempRows = await world.db
        .selectFrom('idempotency_keys')
        .selectAll()
        .where('sender_id', '=', world.workerA)
        .where('key', '=', idempotencyKey)
        .execute();
      expect(idempRows.length).toBe(1);
      expect(idempRows[0]?.message_id).toBe(first.messageId);
    });
  });
});
