import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import type { Kysely } from 'kysely';

import { createDb } from '#persistence/db.js';
import { migrateToLatest } from '#persistence/migrate.js';
import type { Database } from '#persistence/schema.js';

import { createAuditRepo } from './repository.js';
import type { InsertAuditEventInput } from './repository.js';

interface World {
  db: Kysely<Database>;
  hiveId: string;
}

async function seedWorld(): Promise<World> {
  const db = createDb({ dialect: 'sqlite', url: 'sqlite::memory:' });
  await migrateToLatest(db);
  const hiveId = uuidv7();
  await db.insertInto('hives').values({ id: hiveId, name: 'test-hive' }).execute();
  return { db, hiveId };
}

function newDenialEvent(
  world: World,
  overrides: Partial<InsertAuditEventInput> = {},
): InsertAuditEventInput {
  const now = new Date();
  return {
    id: uuidv7(),
    hiveId: world.hiveId,
    occurredAt: now,
    createdAt: now,
    category: 'visibility_denial',
    decision: 'deny',
    actorId: uuidv7(),
    actorKind: 'worker',
    subjectId: uuidv7(),
    subjectKind: 'participant',
    reasonCode: 'worker_to_other_owner_worker',
    detail: '{"senderClass":"worker","recipientClass":"other_owner_worker"}',
    requestId: 'req-abc',
    ...overrides,
  };
}

describe('createAuditRepo', () => {
  let world: World;
  beforeEach(async () => {
    world = await seedWorld();
  });
  afterEach(async () => {
    await world.db.destroy();
  });

  it('insertAuditEvent persists the row and findAuditEventById round-trips it', async () => {
    const repo = createAuditRepo(world.db);
    const event = newDenialEvent(world);
    await repo.insertAuditEvent(event);

    const found = await repo.findAuditEventById(event.id, world.hiveId);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(event.id);
    expect(found?.hiveId).toBe(world.hiveId);
    expect(found?.category).toBe('visibility_denial');
    expect(found?.decision).toBe('deny');
    expect(found?.actorId).toBe(event.actorId);
    expect(found?.actorKind).toBe('worker');
    expect(found?.subjectId).toBe(event.subjectId);
    expect(found?.subjectKind).toBe('participant');
    expect(found?.reasonCode).toBe('worker_to_other_owner_worker');
    expect(found?.detail).toEqual({
      senderClass: 'worker',
      recipientClass: 'other_owner_worker',
    });
    expect(found?.requestId).toBe('req-abc');
    expect(found?.occurredAt).toBeInstanceOf(Date);
    expect(found?.createdAt).toBeInstanceOf(Date);
  });

  it('findAuditEventById returns null for non-existent id', async () => {
    const repo = createAuditRepo(world.db);
    const found = await repo.findAuditEventById(uuidv7(), world.hiveId);
    expect(found).toBeNull();
  });

  it('findAuditEventById is hive-scoped (does not return rows from other Hives)', async () => {
    const repo = createAuditRepo(world.db);
    const event = newDenialEvent(world);
    await repo.insertAuditEvent(event);

    const otherHive = uuidv7();
    await world.db.insertInto('hives').values({ id: otherHive, name: 'other' }).execute();

    const found = await repo.findAuditEventById(event.id, otherHive);
    expect(found).toBeNull();
  });

  it('insertAuditEventBatch persists all events', async () => {
    const repo = createAuditRepo(world.db);
    const events = [newDenialEvent(world), newDenialEvent(world), newDenialEvent(world)];
    await repo.insertAuditEventBatch(events);

    for (const e of events) {
      const found = await repo.findAuditEventById(e.id, world.hiveId);
      expect(found).not.toBeNull();
    }
  });

  it('insertAuditEventBatch with empty array is a no-op', async () => {
    const repo = createAuditRepo(world.db);
    await expect(repo.insertAuditEventBatch([])).resolves.toBeUndefined();
  });

  it('findRecentDenialsBySubject filters by hive + subject + decision=deny', async () => {
    const repo = createAuditRepo(world.db);
    const subject = uuidv7();

    // Two denials targeting `subject`, one allow targeting `subject`, one denial against another subject.
    await repo.insertAuditEvent(newDenialEvent(world, { subjectId: subject }));
    await repo.insertAuditEvent(newDenialEvent(world, { subjectId: subject }));
    await repo.insertAuditEvent(newDenialEvent(world, { subjectId: subject, decision: 'allow' }));
    await repo.insertAuditEvent(newDenialEvent(world, { subjectId: uuidv7() }));

    const denials = await repo.findRecentDenialsBySubject({
      hiveId: world.hiveId,
      subjectId: subject,
    });
    expect(denials).toHaveLength(2);
    for (const d of denials) {
      expect(d.subjectId).toBe(subject);
      expect(d.decision).toBe('deny');
    }
  });

  it('findAuditEventsByFilter narrows by category + actorId', async () => {
    const repo = createAuditRepo(world.db);
    const actor = uuidv7();
    await repo.insertAuditEvent(newDenialEvent(world, { actorId: actor }));
    await repo.insertAuditEvent(
      newDenialEvent(world, { actorId: actor, category: 'admin_purge_run', decision: 'success' }),
    );
    await repo.insertAuditEvent(newDenialEvent(world, { actorId: uuidv7() })); // different actor

    const denialEvents = await repo.findAuditEventsByFilter({
      hiveId: world.hiveId,
      category: 'visibility_denial',
      actorId: actor,
    });
    expect(denialEvents).toHaveLength(1);
    expect(denialEvents[0]?.actorId).toBe(actor);
    expect(denialEvents[0]?.category).toBe('visibility_denial');
  });

  it('findAuditEventsByFilter respects limit', async () => {
    const repo = createAuditRepo(world.db);
    for (let i = 0; i < 10; i += 1) {
      await repo.insertAuditEvent(newDenialEvent(world));
    }
    const events = await repo.findAuditEventsByFilter({ hiveId: world.hiveId, limit: 3 });
    expect(events).toHaveLength(3);
  });

  it('persists null detail and null requestId without serialization noise', async () => {
    const repo = createAuditRepo(world.db);
    const event = newDenialEvent(world, { detail: null, requestId: null });
    await repo.insertAuditEvent(event);
    const found = await repo.findAuditEventById(event.id, world.hiveId);
    expect(found?.detail).toBeNull();
    expect(found?.requestId).toBeNull();
  });

  it('supports system-actor rows (actorId NULL, actorKind=system)', async () => {
    const repo = createAuditRepo(world.db);
    const event = newDenialEvent(world, {
      actorId: null,
      actorKind: 'system',
      category: 'admin_purge_run',
      decision: 'success',
      reasonCode: null,
      subjectId: null,
      subjectKind: null,
    });
    await repo.insertAuditEvent(event);

    const found = await repo.findAuditEventById(event.id, world.hiveId);
    expect(found?.actorId).toBeNull();
    expect(found?.actorKind).toBe('system');
  });
});
