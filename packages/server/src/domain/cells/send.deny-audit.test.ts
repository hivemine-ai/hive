// PRY-087 / INC-2026-009: a send denied by the REAL visibility engine must not
// deadlock on SQLite. The denial audit used to be written on the outer db handle
// while the send transaction held the only connection.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

import type { IdentityContext, UUIDv7 } from '#domain/auth/types.js';
import { createVisibilityEngineForProduction } from '#composition/visibility-engine-factory.js';
import { createLogger } from '#observability/logger.js';
import { createDb } from '#persistence/db.js';
import { migrateToLatest } from '#persistence/migrate.js';
import type { Database } from '#persistence/schema.js';

import { CellError } from './errors.js';
import { createCellEvents } from './events.js';
import { createCellsRepo } from './repository.js';
import { createSender } from './send.js';
import type { Sender } from './send.js';

const PG_URL = process.env['HIVE_TEST_PG_URL'];
const USE_PG = PG_URL !== undefined && PG_URL !== '';

interface World {
  db: Kysely<Database>;
  sender: Sender;
  hiveId: UUIDv7;
  colonyId: UUIDv7;
  hkA: UUIDv7;
  hkB: UUIDv7;
  workerA: UUIDv7;
  workerA2: UUIDv7;
  workerB: UUIDv7;
}

async function seed(): Promise<World> {
  const db = USE_PG
    ? createDb({ dialect: 'postgres', url: PG_URL, postgresPoolSize: 20 })
    : createDb({ dialect: 'sqlite', url: 'sqlite::memory:' });
  if (USE_PG) {
    await sql`drop schema if exists public cascade`.execute(db);
    await sql`create schema public`.execute(db);
  }
  await migrateToLatest(db);

  const hiveId = uuidv7();
  const colonyId = uuidv7();
  const hkA = uuidv7();
  const hkB = uuidv7();
  const workerA = uuidv7();
  const workerA2 = uuidv7();
  const workerB = uuidv7();

  await db.insertInto('hives').values({ id: hiveId, name: 'Deny Audit Hive' }).execute();
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
  for (const [id, name, owner] of [
    [workerA, 'worker-a', hkA],
    [workerA2, 'worker-a2', hkA],
    [workerB, 'worker-b', hkB],
  ] as const) {
    await db
      .insertInto('agents')
      .values({
        id,
        hive_id: hiveId,
        colony_id: colonyId,
        owner_id: owner,
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
  for (const id of [workerA, workerA2, workerB]) {
    await cellsRepo.createCell({ ownerId: id, ownerKind: 'agent', hiveId });
  }

  const visibilityEngine = createVisibilityEngineForProduction({
    db,
    logger: createLogger({ level: 'silent' }),
  });
  const sender = createSender({
    cellsRepo,
    visibilityEngine,
    events: createCellEvents(),
    db,
    config: { dialect: USE_PG ? 'postgres' : 'sqlite' },
  });
  return { db, sender, hiveId, colonyId, hkA, hkB, workerA, workerA2, workerB };
}

function workerContext(world: World, participantId: UUIDv7, ownerId: UUIDv7): IdentityContext {
  return {
    participantId,
    kind: 'worker',
    hiveId: world.hiveId,
    hiveName: 'test-hive',
    colonyId: world.colonyId,
    ownerId,
    snapshot: {
      issuedAt: new Date('2026-04-26T09:00:00.000Z'),
      credentialJti: uuidv7(),
      credentialKid: 'kid-test',
    },
    current: { state: 'active', type: 'worker' },
  };
}

// A hang must fail fast instead of stalling the suite.
function withGuard<T>(p: Promise<T>, ms = 3000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${String(ms)}ms (deadlock?)`)), ms);
  });
  return Promise.race([p, guard]).finally(() => clearTimeout(timer));
}

describe('sendMessage denied by the real visibility engine (PRY-087)', () => {
  let world: World;

  beforeEach(async () => {
    world = await seed();
  });

  afterEach(async () => {
    await world.db.destroy();
  });

  const auditRows = (): Promise<{ reason_code: string | null; actor_id: string | null }[]> =>
    world.db
      .selectFrom('audit_log')
      .select(['reason_code', 'actor_id'])
      .where('category', '=', 'visibility_denial')
      .execute();

  it('rejects a cross-owner worker send promptly, audits the deny and leaves the db usable', async () => {
    const caller = workerContext(world, world.workerA, world.hkA);

    const err = await withGuard(
      world.sender
        .sendMessage({
          callerContext: caller,
          recipientId: world.workerB,
          type: 'notification',
          body: 'denied',
        })
        .catch((e: unknown) => e),
    );

    expect(err).toBeInstanceOf(CellError);
    expect(err).toMatchObject({ code: 'RECIPIENT_UNREACHABLE', subCode: 'visibility_denied' });

    const rows = await withGuard(auditRows());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: world.workerA });

    const allowed = await withGuard(
      world.sender.sendMessage({
        callerContext: caller,
        recipientId: world.workerA2,
        type: 'notification',
        body: 'allowed',
      }),
    );
    expect(allowed.replayed).toBe(false);
  });

  it('audits a denied reply (replyTo set) the same way', async () => {
    const err = await withGuard(
      world.sender
        .sendMessage({
          callerContext: workerContext(world, world.workerA, world.hkA),
          recipientId: world.workerB,
          type: 'notification',
          body: 'denied reply',
          replyTo: uuidv7(),
        })
        .catch((e: unknown) => e),
    );

    expect(err).toMatchObject({ code: 'RECIPIENT_UNREACHABLE', subCode: 'visibility_denied' });
    expect(await withGuard(auditRows())).toHaveLength(1);
  });

  it('audits every deny when several denied sends run concurrently', async () => {
    const caller = workerContext(world, world.workerA, world.hkA);
    const results = await withGuard(
      Promise.all(
        [0, 1, 2].map((i) =>
          world.sender
            .sendMessage({
              callerContext: caller,
              recipientId: world.workerB,
              type: 'notification',
              body: `denied-${String(i)}`,
            })
            .catch((e: unknown) => e),
        ),
      ),
    );

    for (const r of results) {
      expect(r).toMatchObject({ code: 'RECIPIENT_UNREACHABLE', subCode: 'visibility_denied' });
    }
    expect(await withGuard(auditRows())).toHaveLength(3);
  });
});
