import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import type { Kysely } from 'kysely';

import { seedWorld, destroyWorld, type SeedWorld } from '#domain/auth/test-helpers.js';
import { createParticipantsReadRepo } from '#domain/auth/index.js';
import {
  createAuditRecorder,
  getAuditRecordFailureCount,
  resetAuditRecordFailureCounters,
} from '#domain/audit/recorder.js';
import { createAuditRepo } from '#domain/audit/repository.js';
import { jsonStringify } from '#persistence/type-mappers.js';
import type { Database } from '#persistence/schema.js';
import type { IdentityContext } from '#domain/auth/types.js';
import type { Logger } from '#observability/logger.js';

import { createVisibilityEngine, resolveEngineConfig } from './engine.js';

interface RichWorld extends SeedWorld {
  workerOfNonAdminId: string;
  scoutOfNonAdminId: string;
}

async function seedRichWorld(): Promise<RichWorld> {
  const world = await seedWorld();
  const workerOfNonAdminId = uuidv7();
  const scoutOfNonAdminId = uuidv7();
  await world.db
    .insertInto('agents')
    .values({
      id: workerOfNonAdminId,
      hive_id: world.hiveId,
      colony_id: world.colonyId,
      owner_id: world.nonAdminHivekeeperId,
      name: 'worker-na-1',
      type: 'worker',
      capabilities: jsonStringify([]),
      instructions: 'na work',
      state: 'active',
      revoked_at: null,
    })
    .execute();
  await world.db
    .insertInto('agents')
    .values({
      id: scoutOfNonAdminId,
      hive_id: world.hiveId,
      colony_id: world.colonyId,
      owner_id: world.nonAdminHivekeeperId,
      name: 'scout-na-1',
      type: 'scout',
      capabilities: jsonStringify([]),
      instructions: '',
      state: 'active',
      revoked_at: null,
    })
    .execute();
  return { ...world, workerOfNonAdminId, scoutOfNonAdminId };
}

function silentLogger(): Logger {
  const noop = (): void => undefined;
  const stub = {
    error: vi.fn(noop),
    warn: vi.fn(noop),
    info: vi.fn(noop),
    debug: vi.fn(noop),
    trace: vi.fn(noop),
    fatal: vi.fn(noop),
    child: (): Logger => stub,
    level: 'silent',
  } as unknown as Logger;
  return stub;
}

function ctxFor(
  kind: 'hivekeeper' | 'worker' | 'scout',
  participantId: string,
  hiveId: string,
  colonyId: string,
  ownerId?: string,
): IdentityContext {
  const baseSnapshot = {
    issuedAt: new Date('2026-04-26T00:00:00.000Z'),
    credentialJti: 'jti-x',
    credentialKid: 'kid-x',
  };
  const ctx: IdentityContext = {
    participantId,
    kind,
    hiveId,
    colonyId,
    snapshot: baseSnapshot,
    current: kind === 'hivekeeper' ? { state: 'active' } : { state: 'active', type: kind },
  };
  if (ownerId !== undefined) ctx.ownerId = ownerId;
  return ctx;
}

interface EngineHarness {
  world: RichWorld;
  engine: ReturnType<typeof createVisibilityEngine>;
  db: Kysely<Database>;
}

function buildEngine(opts: { world: RichWorld; auditCanSeeDenials?: boolean }): EngineHarness {
  const repo = createParticipantsReadRepo(opts.world.db);
  const auditRepo = createAuditRepo(opts.world.db);
  const recorder = createAuditRecorder({ auditRepo, logger: silentLogger() });
  const config: { auditCanSeeDenials?: boolean } = {};
  if (opts.auditCanSeeDenials !== undefined) {
    config.auditCanSeeDenials = opts.auditCanSeeDenials;
  }
  const engine = createVisibilityEngine({ participantsRepo: repo, recorder }, config);
  return { world: opts.world, engine, db: opts.world.db };
}

async function findDenialsAgainst(
  db: Kysely<Database>,
  hiveId: string,
  subjectId: string,
): Promise<Array<{ reason_code: string | null; actor_id: string | null }>> {
  const rows = await db
    .selectFrom('audit_log')
    .select(['reason_code', 'actor_id'])
    .where('hive_id', '=', hiveId)
    .where('subject_id', '=', subjectId)
    .where('category', '=', 'visibility_denial')
    .execute();
  return rows;
}

describe('visibilityEngine.canSend — happy path (allow)', () => {
  let h: EngineHarness;
  beforeEach(async () => {
    resetAuditRecordFailureCounters();
    const world = await seedRichWorld();
    h = buildEngine({ world });
  });
  afterEach(async () => {
    await destroyWorld(h.world);
    resetAuditRecordFailureCounters();
  });

  it('worker → scout (own owner) → allow + no audit row', async () => {
    const callerCtx = ctxFor(
      'worker',
      h.world.workerAgentId,
      h.world.hiveId,
      h.world.colonyId,
      h.world.adminHivekeeperId,
    );
    const allowed = await h.engine.canSend({
      callerContext: callerCtx,
      recipientId: h.world.scoutAgentId,
    });
    expect(allowed).toBe(true);
    const denials = await findDenialsAgainst(h.db, h.world.hiveId, h.world.scoutAgentId);
    expect(denials).toHaveLength(0);
  });

  it('worker → other-owner scout → allow (Scouts are public) + no audit row', async () => {
    const callerCtx = ctxFor(
      'worker',
      h.world.workerAgentId,
      h.world.hiveId,
      h.world.colonyId,
      h.world.adminHivekeeperId,
    );
    const allowed = await h.engine.canSend({
      callerContext: callerCtx,
      recipientId: h.world.scoutOfNonAdminId,
    });
    expect(allowed).toBe(true);
    expect(await findDenialsAgainst(h.db, h.world.hiveId, h.world.scoutOfNonAdminId)).toHaveLength(
      0,
    );
  });

  it('worker → own_hivekeeper → allow', async () => {
    const callerCtx = ctxFor(
      'worker',
      h.world.workerAgentId,
      h.world.hiveId,
      h.world.colonyId,
      h.world.adminHivekeeperId,
    );
    const allowed = await h.engine.canSend({
      callerContext: callerCtx,
      recipientId: h.world.adminHivekeeperId,
    });
    expect(allowed).toBe(true);
  });

  it('hivekeeper → other hivekeeper → allow', async () => {
    const callerCtx = ctxFor(
      'hivekeeper',
      h.world.adminHivekeeperId,
      h.world.hiveId,
      h.world.colonyId,
    );
    const allowed = await h.engine.canSend({
      callerContext: callerCtx,
      recipientId: h.world.nonAdminHivekeeperId,
    });
    expect(allowed).toBe(true);
  });

  it('self-message → allow + no audit', async () => {
    const callerCtx = ctxFor(
      'worker',
      h.world.workerAgentId,
      h.world.hiveId,
      h.world.colonyId,
      h.world.adminHivekeeperId,
    );
    const allowed = await h.engine.canSend({
      callerContext: callerCtx,
      recipientId: h.world.workerAgentId,
    });
    expect(allowed).toBe(true);
    expect(await findDenialsAgainst(h.db, h.world.hiveId, h.world.workerAgentId)).toHaveLength(0);
  });

  it('recipient suspended → allow (state not evaluated by engine, per invariant 2)', async () => {
    await h.db
      .updateTable('agents')
      .set({ state: 'suspended' })
      .where('id', '=', h.world.scoutAgentId)
      .execute();

    const callerCtx = ctxFor(
      'worker',
      h.world.workerAgentId,
      h.world.hiveId,
      h.world.colonyId,
      h.world.adminHivekeeperId,
    );
    const allowed = await h.engine.canSend({
      callerContext: callerCtx,
      recipientId: h.world.scoutAgentId,
    });
    expect(allowed).toBe(true);
  });
});

describe('visibilityEngine.canSend — deny + audit invariant', () => {
  let h: EngineHarness;
  beforeEach(async () => {
    resetAuditRecordFailureCounters();
    const world = await seedRichWorld();
    h = buildEngine({ world });
  });
  afterEach(async () => {
    await destroyWorld(h.world);
    resetAuditRecordFailureCounters();
  });

  it('worker → other-owner worker → deny + audit row with reason worker_to_other_owner_worker', async () => {
    const callerCtx = ctxFor(
      'worker',
      h.world.workerAgentId,
      h.world.hiveId,
      h.world.colonyId,
      h.world.adminHivekeeperId,
    );
    const allowed = await h.engine.canSend({
      callerContext: callerCtx,
      recipientId: h.world.workerOfNonAdminId,
    });
    expect(allowed).toBe(false);
    const denials = await findDenialsAgainst(h.db, h.world.hiveId, h.world.workerOfNonAdminId);
    expect(denials).toHaveLength(1);
    expect(denials[0]?.reason_code).toBe('worker_to_other_owner_worker');
    expect(denials[0]?.actor_id).toBe(h.world.workerAgentId);
  });

  it('hivekeeper → other-owner worker → deny + reason hivekeeper_to_other_owner_worker', async () => {
    const callerCtx = ctxFor(
      'hivekeeper',
      h.world.adminHivekeeperId,
      h.world.hiveId,
      h.world.colonyId,
    );
    const allowed = await h.engine.canSend({
      callerContext: callerCtx,
      recipientId: h.world.workerOfNonAdminId,
    });
    expect(allowed).toBe(false);
    const denials = await findDenialsAgainst(h.db, h.world.hiveId, h.world.workerOfNonAdminId);
    expect(denials).toHaveLength(1);
    expect(denials[0]?.reason_code).toBe('hivekeeper_to_other_owner_worker');
  });

  it('worker → other hivekeeper → deny + reason worker_to_other_hivekeeper', async () => {
    const callerCtx = ctxFor(
      'worker',
      h.world.workerAgentId,
      h.world.hiveId,
      h.world.colonyId,
      h.world.adminHivekeeperId,
    );
    const allowed = await h.engine.canSend({
      callerContext: callerCtx,
      recipientId: h.world.nonAdminHivekeeperId,
    });
    expect(allowed).toBe(false);
    const denials = await findDenialsAgainst(h.db, h.world.hiveId, h.world.nonAdminHivekeeperId);
    expect(denials).toHaveLength(1);
    expect(denials[0]?.reason_code).toBe('worker_to_other_hivekeeper');
  });

  it('scout → other-owner worker → deny + reason scout_to_other_owner_worker', async () => {
    const callerCtx = ctxFor(
      'scout',
      h.world.scoutAgentId,
      h.world.hiveId,
      h.world.colonyId,
      h.world.adminHivekeeperId,
    );
    const allowed = await h.engine.canSend({
      callerContext: callerCtx,
      recipientId: h.world.workerOfNonAdminId,
    });
    expect(allowed).toBe(false);
    const denials = await findDenialsAgainst(h.db, h.world.hiveId, h.world.workerOfNonAdminId);
    expect(denials).toHaveLength(1);
    expect(denials[0]?.reason_code).toBe('scout_to_other_owner_worker');
  });

  it('scout → other-owner scout → allow (row 14b)', async () => {
    const callerCtx = ctxFor(
      'scout',
      h.world.scoutAgentId,
      h.world.hiveId,
      h.world.colonyId,
      h.world.adminHivekeeperId,
    );
    const allowed = await h.engine.canSend({
      callerContext: callerCtx,
      recipientId: h.world.scoutOfNonAdminId,
    });
    expect(allowed).toBe(true);
  });

  it('scout → other hivekeeper → allow (Scouts can write to Hive humans)', async () => {
    const callerCtx = ctxFor(
      'scout',
      h.world.scoutAgentId,
      h.world.hiveId,
      h.world.colonyId,
      h.world.adminHivekeeperId,
    );
    const allowed = await h.engine.canSend({
      callerContext: callerCtx,
      recipientId: h.world.nonAdminHivekeeperId,
    });
    expect(allowed).toBe(true);
  });

  it('recipient_not_found → deny + audit row with reason recipient_not_found', async () => {
    const ghostId = uuidv7();
    const callerCtx = ctxFor(
      'worker',
      h.world.workerAgentId,
      h.world.hiveId,
      h.world.colonyId,
      h.world.adminHivekeeperId,
    );
    const allowed = await h.engine.canSend({
      callerContext: callerCtx,
      recipientId: ghostId,
    });
    expect(allowed).toBe(false);
    const denials = await findDenialsAgainst(h.db, h.world.hiveId, ghostId);
    expect(denials).toHaveLength(1);
    expect(denials[0]?.reason_code).toBe('recipient_not_found');
  });

  it('cross-Hive recipient → deny + reason cross_hive', async () => {
    // Provision a second Hive + a recipient in it.
    const otherHive = uuidv7();
    const otherColony = uuidv7();
    const otherKeeper = uuidv7();
    await h.db.insertInto('hives').values({ id: otherHive, name: 'other' }).execute();
    await h.db
      .insertInto('colonies')
      .values({ id: otherColony, hive_id: otherHive, name: 'c' })
      .execute();
    await h.db
      .insertInto('hivekeepers')
      .values({
        id: otherKeeper,
        hive_id: otherHive,
        colony_id: otherColony,
        email: 'k@other.com',
        display_name: null,
        is_admin: 1,
        state: 'active',
        revoked_at: null,
      })
      .execute();

    const callerCtx = ctxFor(
      'worker',
      h.world.workerAgentId,
      h.world.hiveId,
      h.world.colonyId,
      h.world.adminHivekeeperId,
    );
    const allowed = await h.engine.canSend({
      callerContext: callerCtx,
      recipientId: otherKeeper,
    });
    expect(allowed).toBe(false);
    const denials = await findDenialsAgainst(h.db, h.world.hiveId, otherKeeper);
    expect(denials).toHaveLength(1);
    expect(denials[0]?.reason_code).toBe('cross_hive');
  });

  it('audit detail captures senderClass + recipientClass for correlation', async () => {
    const callerCtx = ctxFor(
      'worker',
      h.world.workerAgentId,
      h.world.hiveId,
      h.world.colonyId,
      h.world.adminHivekeeperId,
    );
    await h.engine.canSend({
      callerContext: callerCtx,
      recipientId: h.world.workerOfNonAdminId,
    });
    const row = await h.db
      .selectFrom('audit_log')
      .selectAll()
      .where('subject_id', '=', h.world.workerOfNonAdminId)
      .executeTakeFirstOrThrow();
    expect(row.detail).not.toBeNull();
    const detail = JSON.parse(row.detail!) as { senderClass: string; recipientClass: string };
    expect(detail.senderClass).toBe('worker');
    expect(detail.recipientClass).toBe('other_owner_worker');
  });

  it('requestId, when provided, is persisted to audit row for correlation', async () => {
    const callerCtx = ctxFor(
      'worker',
      h.world.workerAgentId,
      h.world.hiveId,
      h.world.colonyId,
      h.world.adminHivekeeperId,
    );
    await h.engine.canSend({
      callerContext: callerCtx,
      recipientId: h.world.workerOfNonAdminId,
      requestId: 'req-xyz-42',
    });
    const row = await h.db
      .selectFrom('audit_log')
      .selectAll()
      .where('subject_id', '=', h.world.workerOfNonAdminId)
      .executeTakeFirstOrThrow();
    expect(row.request_id).toBe('req-xyz-42');
  });
});

describe('visibilityEngine.canSee', () => {
  let h: EngineHarness;
  beforeEach(async () => {
    resetAuditRecordFailureCounters();
    const world = await seedRichWorld();
    h = buildEngine({ world });
  });
  afterEach(async () => {
    await destroyWorld(h.world);
    resetAuditRecordFailureCounters();
  });

  it('hivekeeper sees other hivekeeper of the same Hive', async () => {
    const callerCtx = ctxFor(
      'hivekeeper',
      h.world.adminHivekeeperId,
      h.world.hiveId,
      h.world.colonyId,
    );
    expect(
      await h.engine.canSee({ callerContext: callerCtx, targetId: h.world.nonAdminHivekeeperId }),
    ).toBe(true);
  });

  it('hivekeeper sees own worker', async () => {
    const callerCtx = ctxFor(
      'hivekeeper',
      h.world.adminHivekeeperId,
      h.world.hiveId,
      h.world.colonyId,
    );
    expect(
      await h.engine.canSee({ callerContext: callerCtx, targetId: h.world.workerAgentId }),
    ).toBe(true);
  });

  it('hivekeeper does NOT see worker of another keeper', async () => {
    const callerCtx = ctxFor(
      'hivekeeper',
      h.world.adminHivekeeperId,
      h.world.hiveId,
      h.world.colonyId,
    );
    expect(
      await h.engine.canSee({ callerContext: callerCtx, targetId: h.world.workerOfNonAdminId }),
    ).toBe(false);
  });

  it('any participant sees a Scout (Scouts are public)', async () => {
    const callerCtx = ctxFor(
      'worker',
      h.world.workerAgentId,
      h.world.hiveId,
      h.world.colonyId,
      h.world.adminHivekeeperId,
    );
    expect(
      await h.engine.canSee({ callerContext: callerCtx, targetId: h.world.scoutOfNonAdminId }),
    ).toBe(true);
  });

  it('agent does NOT see Hivekeeper directory entries (sub-rule derived)', async () => {
    const callerCtx = ctxFor(
      'worker',
      h.world.workerAgentId,
      h.world.hiveId,
      h.world.colonyId,
      h.world.adminHivekeeperId,
    );
    expect(
      await h.engine.canSee({ callerContext: callerCtx, targetId: h.world.nonAdminHivekeeperId }),
    ).toBe(false);
  });

  it('canSee denial does NOT write audit row by default', async () => {
    const callerCtx = ctxFor(
      'worker',
      h.world.workerAgentId,
      h.world.hiveId,
      h.world.colonyId,
      h.world.adminHivekeeperId,
    );
    await h.engine.canSee({ callerContext: callerCtx, targetId: h.world.workerOfNonAdminId });
    const denials = await findDenialsAgainst(h.db, h.world.hiveId, h.world.workerOfNonAdminId);
    expect(denials).toHaveLength(0);
  });

  it('canSee denial DOES write audit row when auditCanSeeDenials=true', async () => {
    await destroyWorld(h.world);
    const world = await seedRichWorld();
    h = buildEngine({ world, auditCanSeeDenials: true });

    const callerCtx = ctxFor(
      'worker',
      h.world.workerAgentId,
      h.world.hiveId,
      h.world.colonyId,
      h.world.adminHivekeeperId,
    );
    await h.engine.canSee({ callerContext: callerCtx, targetId: h.world.workerOfNonAdminId });

    const denials = await findDenialsAgainst(h.db, h.world.hiveId, h.world.workerOfNonAdminId);
    expect(denials).toHaveLength(1);
    expect(denials[0]?.reason_code).toBe('cansee_denied');
  });
});

describe('resolveEngineConfig', () => {
  const ENV_KEY = 'HIVE_VISIBILITY_AUDIT_CANSEE_DENIALS';
  let originalEnv: string | undefined;
  beforeEach(() => {
    originalEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalEnv;
  });

  it('defaults auditCanSeeDenials to false', () => {
    expect(resolveEngineConfig().auditCanSeeDenials).toBe(false);
  });
  it('reads truthy env (true)', () => {
    process.env[ENV_KEY] = 'true';
    expect(resolveEngineConfig().auditCanSeeDenials).toBe(true);
  });
  it('reads truthy env (1)', () => {
    process.env[ENV_KEY] = '1';
    expect(resolveEngineConfig().auditCanSeeDenials).toBe(true);
  });
  it('config arg overrides env', () => {
    process.env[ENV_KEY] = 'true';
    expect(resolveEngineConfig({ auditCanSeeDenials: false }).auditCanSeeDenials).toBe(false);
  });
});

describe('visibilityEngine — failure-mode safety', () => {
  let h: EngineHarness;
  beforeEach(async () => {
    resetAuditRecordFailureCounters();
    const world = await seedRichWorld();
    h = buildEngine({ world });
  });
  afterEach(async () => {
    await destroyWorld(h.world);
    resetAuditRecordFailureCounters();
  });

  it('counter is incremented on audit write failure but canSend still returns the right boolean', async () => {
    // Drop audit_log to force INSERT to fail mid-test.
    await h.db.schema.dropTable('audit_log').execute();

    const callerCtx = ctxFor(
      'worker',
      h.world.workerAgentId,
      h.world.hiveId,
      h.world.colonyId,
      h.world.adminHivekeeperId,
    );
    const allowed = await h.engine.canSend({
      callerContext: callerCtx,
      recipientId: h.world.workerOfNonAdminId,
    });
    expect(allowed).toBe(false); // decision is correct
    expect(getAuditRecordFailureCount('visibility_denial')).toBeGreaterThanOrEqual(1);
  });
});
