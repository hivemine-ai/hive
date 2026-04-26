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

  it('privacidad uniforme: messages from another Cell collapse to ignored (no error)', async () => {
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
});
