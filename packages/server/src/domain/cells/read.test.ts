import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';

import type { Kysely } from 'kysely';

import type { IdentityContext, UUIDv7 } from '#domain/auth/types.js';
import { createDb } from '#persistence/db.js';
import { migrateToLatest } from '#persistence/migrate.js';
import type { Database } from '#persistence/schema.js';

import { CellError } from './errors.js';
import { createReader } from './read.js';
import type { Reader, ReaderConfig } from './read.js';
import { createCellsRepo } from './repository.js';
import type { CellsRepo } from './repository.js';
import type { Message } from './types.js';

interface ReadWorld {
  db: Kysely<Database>;
  cellsRepo: CellsRepo;
  hiveId: UUIDv7;
  colonyId: UUIDv7;
  hkA: UUIDv7;
  workerA: UUIDv7;
  workerB: UUIDv7;
  cellA: UUIDv7;
  cellB: UUIDv7;
}

async function seedReadWorld(): Promise<ReadWorld> {
  const db = createDb({ dialect: 'sqlite', url: 'sqlite::memory:' });
  await migrateToLatest(db);

  const hiveId = uuidv7();
  const colonyId = uuidv7();
  const hkA = uuidv7();
  const workerA = uuidv7();
  const workerB = uuidv7();

  await db.insertInto('hives').values({ id: hiveId, name: 'Read Test Hive' }).execute();
  await db
    .insertInto('colonies')
    .values({ id: colonyId, hive_id: hiveId, name: 'default' })
    .execute();
  await db
    .insertInto('hivekeepers')
    .values({
      id: hkA,
      hive_id: hiveId,
      colony_id: colonyId,
      email: 'a@example.com',
      display_name: null,
      is_admin: 1,
      state: 'active',
      revoked_at: null,
    })
    .execute();
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
    hiveId,
    colonyId,
    hkA,
    workerA,
    workerB,
    cellA: cellA.id,
    cellB: cellB.id,
  };
}

function buildContext(world: ReadWorld, participantId: UUIDv7): IdentityContext {
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

function buildReader(
  world: ReadWorld,
  options: { config?: Partial<ReaderConfig>; now?: () => Date } = {},
): Reader {
  return createReader({
    cellsRepo: world.cellsRepo,
    db: world.db,
    ...(options.config !== undefined ? { config: options.config } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
}

async function insertDeliveredMessages(
  world: ReadWorld,
  cellId: UUIDv7,
  count: number,
  baseIso = '2026-04-26T10:00:00.000Z',
): Promise<Message[]> {
  const baseTime = new Date(baseIso).getTime();
  const messages: Message[] = [];
  for (let i = 0; i < count; i++) {
    const m: Message = {
      id: uuidv7(),
      cellId,
      fromParticipantId: world.workerA,
      toParticipantId: world.workerB,
      type: i % 2 === 0 ? 'request' : 'notification',
      body: `body-${i}`,
      action: null,
      replyTo: null,
      ttl: null,
      sentAt: new Date(baseTime + i * 1000),
      deliveredAt: new Date(baseTime + i * 1000),
      readAt: null,
      state: 'delivered',
      expiredAt: null,
    };
    await world.cellsRepo.insertMessage(m);
    messages.push(m);
  }
  return messages;
}

describe('createReader / readMailbox', () => {
  let world: ReadWorld;

  beforeEach(async () => {
    world = await seedReadWorld();
  });

  afterEach(async () => {
    await world.db.destroy();
  });

  it('returns the caller cell messages newest-first as MessageView', async () => {
    const reader = buildReader(world);
    const seeded = await insertDeliveredMessages(world, world.cellB, 3);

    const result = await reader.readMailbox({
      callerContext: buildContext(world, world.workerB),
    });
    expect(result.length).toBe(3);
    expect(result[0]?.id).toBe(seeded[2]?.id);
    expect(result[2]?.id).toBe(seeded[0]?.id);
    // Verify the projection shape (consumer-facing fields).
    expect(result[0]?.from).toBe(world.workerA);
    expect(result[0]?.to).toBe(world.workerB);
    expect(result[0]?.state).toBe('delivered');
    expect(result[0]?.readAt).toBeNull();
    expect(result[0]?.deliveredAt).toBeInstanceOf(Date);
  });

  it('applies the unreadOnly filter', async () => {
    const reader = buildReader(world);
    const seeded = await insertDeliveredMessages(world, world.cellB, 2);
    // Mark the first as read directly via the repo.
    await world.cellsRepo.markMessageRead(
      seeded[0]!.id,
      world.cellB,
      new Date('2026-04-26T11:00:00.000Z'),
    );

    const onlyUnread = await reader.readMailbox({
      callerContext: buildContext(world, world.workerB),
      filter: { unreadOnly: true },
    });
    expect(onlyUnread.length).toBe(1);
    expect(onlyUnread[0]?.id).toBe(seeded[1]?.id);
  });

  it('forwards the types filter', async () => {
    const reader = buildReader(world);
    await insertDeliveredMessages(world, world.cellB, 4);
    const onlyNotifications = await reader.readMailbox({
      callerContext: buildContext(world, world.workerB),
      filter: { types: ['notification'] },
    });
    expect(onlyNotifications.length).toBeGreaterThan(0);
    expect(onlyNotifications.every((m) => m.type === 'notification')).toBe(true);
  });

  it('paginates deterministically across pages via the keyset cursor', async () => {
    const reader = buildReader(world);
    const seeded = await insertDeliveredMessages(world, world.cellB, 5);
    const seenIds = new Set<string>();

    const ctx = buildContext(world, world.workerB);
    const page1 = await reader.readMailbox({
      callerContext: ctx,
      pagination: { cursor: null, limit: 2 },
    });
    expect(page1.length).toBe(2);
    page1.forEach((m) => seenIds.add(m.id));

    const cursor1 = page1[page1.length - 1]!;
    const page2 = await reader.readMailbox({
      callerContext: ctx,
      pagination: {
        cursor: { deliveredAt: cursor1.deliveredAt, messageId: cursor1.id },
        limit: 2,
      },
    });
    expect(page2.length).toBe(2);
    page2.forEach((m) => seenIds.add(m.id));

    const cursor2 = page2[page2.length - 1]!;
    const page3 = await reader.readMailbox({
      callerContext: ctx,
      pagination: {
        cursor: { deliveredAt: cursor2.deliveredAt, messageId: cursor2.id },
        limit: 2,
      },
    });
    expect(page3.length).toBe(1);
    page3.forEach((m) => seenIds.add(m.id));

    expect(seenIds.size).toBe(seeded.length);
  });

  it('caps the limit at config.readMaxPageSize', async () => {
    const reader = buildReader(world, { config: { readMaxPageSize: 2 } });
    await insertDeliveredMessages(world, world.cellB, 5);
    const result = await reader.readMailbox({
      callerContext: buildContext(world, world.workerB),
      pagination: { cursor: null, limit: 1000 },
    });
    expect(result.length).toBe(2);
  });

  it('uses readDefaultPageSize when no limit is given', async () => {
    const reader = buildReader(world, { config: { readDefaultPageSize: 1 } });
    await insertDeliveredMessages(world, world.cellB, 3);
    const result = await reader.readMailbox({
      callerContext: buildContext(world, world.workerB),
    });
    expect(result.length).toBe(1);
  });

  it('throws INTERNAL_INCONSISTENCY when the caller has no Cell', async () => {
    const reader = buildReader(world);
    await expect(
      reader.readMailbox({
        callerContext: buildContext(world, uuidv7()),
      }),
    ).rejects.toMatchObject({
      code: 'INTERNAL_INCONSISTENCY',
      subCode: 'caller_has_no_cell',
    });
  });
});

describe('createReader / markRead', () => {
  let world: ReadWorld;

  beforeEach(async () => {
    world = await seedReadWorld();
  });

  afterEach(async () => {
    await world.db.destroy();
  });

  it('marks a delivered message as read and returns it in marked', async () => {
    const reader = buildReader(world);
    const [m] = await insertDeliveredMessages(world, world.cellB, 1);

    const result = await reader.markRead({
      callerContext: buildContext(world, world.workerB),
      messageIds: [m!.id],
    });
    expect(result.marked).toEqual([m!.id]);
    expect(result.ignored).toEqual([]);

    const after = await reader.readMailbox({
      callerContext: buildContext(world, world.workerB),
    });
    expect(after[0]?.state).toBe('read');
    expect(after[0]?.readAt).toBeInstanceOf(Date);
  });

  it('is idempotent: re-marking a read message returns it in ignored', async () => {
    const reader = buildReader(world);
    const [m] = await insertDeliveredMessages(world, world.cellB, 1);
    const ctx = buildContext(world, world.workerB);

    const first = await reader.markRead({ callerContext: ctx, messageIds: [m!.id] });
    expect(first.marked).toEqual([m!.id]);
    const second = await reader.markRead({ callerContext: ctx, messageIds: [m!.id] });
    expect(second.marked).toEqual([]);
    expect(second.ignored).toEqual([m!.id]);
  });

  it('uniform privacy: messages from another Cell collapse to ignored (no error)', async () => {
    const reader = buildReader(world);
    // Deliver a message into workerA's cell, then have workerB try to mark it.
    const [foreign] = await insertDeliveredMessages(world, world.cellA, 1);

    const result = await reader.markRead({
      callerContext: buildContext(world, world.workerB),
      messageIds: [foreign!.id],
    });
    expect(result.marked).toEqual([]);
    expect(result.ignored).toEqual([foreign!.id]);
  });

  it('mixes marked and ignored in the same call', async () => {
    const reader = buildReader(world);
    const ours = await insertDeliveredMessages(world, world.cellB, 1);
    const foreign = await insertDeliveredMessages(
      world,
      world.cellA,
      1,
      '2026-04-26T12:00:00.000Z',
    );
    const unknownId = uuidv7();

    const result = await reader.markRead({
      callerContext: buildContext(world, world.workerB),
      messageIds: [ours[0]!.id, foreign[0]!.id, unknownId],
    });
    expect(result.marked).toEqual([ours[0]!.id]);
    expect(new Set(result.ignored)).toEqual(new Set([foreign[0]!.id, unknownId]));
  });

  it('throws INTERNAL_INCONSISTENCY when the caller has no Cell', async () => {
    const reader = buildReader(world);
    await expect(
      reader.markRead({
        callerContext: buildContext(world, uuidv7()),
        messageIds: [uuidv7()],
      }),
    ).rejects.toBeInstanceOf(CellError);
  });

  it('returns marked: [] and ignored: [] for an empty messageIds array', async () => {
    const reader = buildReader(world);
    const result = await reader.markRead({
      callerContext: buildContext(world, world.workerB),
      messageIds: [],
    });
    expect(result.marked).toEqual([]);
    expect(result.ignored).toEqual([]);
  });

  it('throws INVALID_INPUT when messageIds.length exceeds markReadMaxIds', async () => {
    const reader = buildReader(world, { config: { markReadMaxIds: 2 } });
    await expect(
      reader.markRead({
        callerContext: buildContext(world, world.workerB),
        messageIds: [uuidv7(), uuidv7(), uuidv7()],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', subCode: 'message_ids_too_many' });
  });
});

describe('readMailbox — additional filter and pagination contracts', () => {
  let world: ReadWorld;

  beforeEach(async () => {
    world = await seedReadWorld();
  });

  afterEach(async () => {
    await world.db.destroy();
  });

  it('throws INVALID_INPUT when pagination.limit <= 0', async () => {
    const reader = buildReader(world);
    await expect(
      reader.readMailbox({
        callerContext: buildContext(world, world.workerB),
        pagination: { cursor: null, limit: 0 },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', subCode: 'limit_not_positive' });
  });

  it('filter.state pins messages to a specific state', async () => {
    const reader = buildReader(world);
    const [m1, m2] = await insertDeliveredMessages(world, world.cellB, 2);
    // Mark one as read directly via the repo.
    await world.cellsRepo.markMessageRead(m1!.id, world.cellB, new Date());

    const onlyRead = await reader.readMailbox({
      callerContext: buildContext(world, world.workerB),
      filter: { state: 'read' },
    });
    expect(onlyRead.map((mv) => mv.id)).toEqual([m1!.id]);

    const onlyDelivered = await reader.readMailbox({
      callerContext: buildContext(world, world.workerB),
      filter: { state: 'delivered' },
    });
    expect(onlyDelivered.map((mv) => mv.id)).toEqual([m2!.id]);
  });

  it('filter.inReplyTo restricts results to replies of a specific message', async () => {
    const reader = buildReader(world);
    const originalId = uuidv7();
    await world.cellsRepo.insertMessage({
      id: originalId,
      cellId: world.cellB,
      fromParticipantId: world.workerA,
      toParticipantId: world.workerB,
      type: 'request',
      body: 'q?',
      action: null,
      replyTo: null,
      ttl: null,
      sentAt: new Date('2026-04-26T11:00:00.000Z'),
      deliveredAt: new Date('2026-04-26T11:00:00.000Z'),
      readAt: null,
      state: 'delivered',
      expiredAt: null,
    });
    const replyId = uuidv7();
    await world.cellsRepo.insertMessage({
      id: replyId,
      cellId: world.cellB,
      fromParticipantId: world.workerA,
      toParticipantId: world.workerB,
      type: 'response',
      body: 'a!',
      action: null,
      replyTo: originalId,
      ttl: null,
      sentAt: new Date('2026-04-26T11:00:01.000Z'),
      deliveredAt: new Date('2026-04-26T11:00:01.000Z'),
      readAt: null,
      state: 'delivered',
      expiredAt: null,
    });

    const replies = await reader.readMailbox({
      callerContext: buildContext(world, world.workerB),
      filter: { inReplyTo: originalId },
    });
    expect(replies.map((mv) => mv.id)).toEqual([replyId]);
  });
});

// PRY-020 — filter.from must apply end-to-end. Closes INC-2026-001 #1: the
// previous implementation declared `from` in the public schema but ignored
// it in the query, leaking ALL messages to a caller that thought it was
// filtering by sender (silent footgun pattern from PRY-003 lesson).
describe('readMailbox — filter.from (PRY-020, INC-2026-001 #1)', () => {
  let world: ReadWorld;

  beforeEach(async () => {
    world = await seedReadWorld();
  });

  afterEach(async () => {
    await world.db.destroy();
  });

  /** Inserts a message to `cellId` from `fromId` with a stable ts offset. */
  async function insertFrom(
    cellId: UUIDv7,
    fromId: UUIDv7,
    toId: UUIDv7,
    bodySuffix: string,
    tsOffsetMs: number,
  ): Promise<UUIDv7> {
    const id = uuidv7();
    const ts = new Date('2026-04-26T10:00:00.000Z').getTime() + tsOffsetMs;
    await world.cellsRepo.insertMessage({
      id,
      cellId,
      fromParticipantId: fromId,
      toParticipantId: toId,
      type: 'notification',
      body: `from-${bodySuffix}`,
      action: null,
      replyTo: null,
      ttl: null,
      sentAt: new Date(ts),
      deliveredAt: new Date(ts),
      readAt: null,
      state: 'delivered',
      expiredAt: null,
    });
    return id;
  }

  it('returns only messages from the matching sender when filter.from is set', async () => {
    // workerB receives 2 messages from workerA + 2 messages from hkA.
    const fromA1 = await insertFrom(world.cellB, world.workerA, world.workerB, 'a-1', 0);
    const fromA2 = await insertFrom(world.cellB, world.workerA, world.workerB, 'a-2', 1000);
    const fromHk1 = await insertFrom(world.cellB, world.hkA, world.workerB, 'hk-1', 2000);
    const fromHk2 = await insertFrom(world.cellB, world.hkA, world.workerB, 'hk-2', 3000);

    const reader = buildReader(world);

    const onlyA = await reader.readMailbox({
      callerContext: buildContext(world, world.workerB),
      filter: { from: world.workerA },
    });
    expect(new Set(onlyA.map((mv) => mv.id))).toEqual(new Set([fromA1, fromA2]));

    const onlyHk = await reader.readMailbox({
      callerContext: buildContext(world, world.workerB),
      filter: { from: world.hkA },
    });
    expect(new Set(onlyHk.map((mv) => mv.id))).toEqual(new Set([fromHk1, fromHk2]));
  });

  it('returns all messages when filter.from is omitted (no regression)', async () => {
    await insertFrom(world.cellB, world.workerA, world.workerB, 'a', 0);
    await insertFrom(world.cellB, world.hkA, world.workerB, 'hk', 1000);

    const reader = buildReader(world);
    const all = await reader.readMailbox({
      callerContext: buildContext(world, world.workerB),
    });
    expect(all.length).toBe(2);
  });

  it('returns [] when filter.from points at a sender with no messages in this Cell', async () => {
    // Insert messages from workerA into cellB; query with filter.from = a fresh UUID.
    await insertFrom(world.cellB, world.workerA, world.workerB, 'a', 0);
    const ghostId = uuidv7();

    const reader = buildReader(world);
    const result = await reader.readMailbox({
      callerContext: buildContext(world, world.workerB),
      filter: { from: ghostId },
    });
    expect(result).toEqual([]);
  });

  it('combines filter.from with filter.state (AND semantics)', async () => {
    // 2 from workerA: 1 delivered, 1 read.
    // 1 from hkA: delivered.
    const fromADelivered = await insertFrom(world.cellB, world.workerA, world.workerB, 'a-d', 0);
    const fromARead = uuidv7();
    const ts = new Date('2026-04-26T10:00:01.000Z');
    await world.cellsRepo.insertMessage({
      id: fromARead,
      cellId: world.cellB,
      fromParticipantId: world.workerA,
      toParticipantId: world.workerB,
      type: 'notification',
      body: 'from-a-r',
      action: null,
      replyTo: null,
      ttl: null,
      sentAt: ts,
      deliveredAt: ts,
      readAt: ts,
      state: 'read',
      expiredAt: null,
    });
    await insertFrom(world.cellB, world.hkA, world.workerB, 'hk-d', 2000);

    const reader = buildReader(world);
    const onlyDeliveredFromA = await reader.readMailbox({
      callerContext: buildContext(world, world.workerB),
      filter: { from: world.workerA, state: 'delivered' },
    });
    expect(onlyDeliveredFromA.map((mv) => mv.id)).toEqual([fromADelivered]);
  });
});
