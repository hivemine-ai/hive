import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { seedWorld, destroyWorld, type SeedWorld } from '#domain/auth/test-helpers.js';
import { createLogger } from '#observability/logger.js';
import type { IdentityContext } from '#domain/auth/types.js';

import { createVisibilityEngineForProduction } from './visibility-engine-factory.js';
import { stubVisibilityEngine } from './stubs.js';

function ctxFor(
  kind: 'hivekeeper' | 'worker' | 'scout',
  participantId: string,
  hiveId: string,
  colonyId: string,
  ownerId?: string,
): IdentityContext {
  const ctx: IdentityContext = {
    participantId,
    kind,
    hiveId,
    colonyId,
    snapshot: {
      issuedAt: new Date('2026-04-26T00:00:00.000Z'),
      credentialJti: 'jti-1',
      credentialKid: 'kid-1',
    },
    current: kind === 'hivekeeper' ? { state: 'active' } : { state: 'active', type: kind },
  };
  if (ownerId !== undefined) ctx.ownerId = ownerId;
  return ctx;
}

describe('createVisibilityEngineForProduction', () => {
  let world: SeedWorld;
  beforeEach(async () => {
    world = await seedWorld();
  });
  afterEach(async () => {
    await destroyWorld(world);
  });

  it('returns an engine that hits the real participants repo (no stub)', async () => {
    const logger = createLogger({ level: 'silent' });
    const engine = createVisibilityEngineForProduction({ db: world.db, logger });

    // The real engine must dereference findById against the real DB —
    // a non-existent recipient must trigger `recipient_not_found` deny + audit row.
    const ghostId = 'no-such-id-' + String(Math.random());
    const callerCtx = ctxFor(
      'worker',
      world.workerAgentId,
      world.hiveId,
      world.colonyId,
      world.adminHivekeeperId,
    );
    const allowed = await engine.canSend({ callerContext: callerCtx, recipientId: ghostId });
    expect(allowed).toBe(false);

    const denial = await world.db
      .selectFrom('audit_log')
      .select(['reason_code'])
      .where('subject_id', '=', ghostId)
      .where('category', '=', 'visibility_denial')
      .executeTakeFirst();
    expect(denial?.reason_code).toBe('recipient_not_found');
  });

  it('the production engine is NOT the same object as `stubVisibilityEngine`', () => {
    const logger = createLogger({ level: 'silent' });
    const engine = createVisibilityEngineForProduction({ db: world.db, logger });
    expect(engine).not.toBe(stubVisibilityEngine);
  });

  it('forwards `auditCanSeeDenials` option to the engine', async () => {
    const logger = createLogger({ level: 'silent' });
    const engine = createVisibilityEngineForProduction(
      { db: world.db, logger },
      { auditCanSeeDenials: true },
    );

    const callerCtx = ctxFor(
      'worker',
      world.workerAgentId,
      world.hiveId,
      world.colonyId,
      world.adminHivekeeperId,
    );
    // Worker tries to "see" the non-admin keeper → denied per derived rule.
    await engine.canSee({ callerContext: callerCtx, targetId: world.nonAdminHivekeeperId });

    const denial = await world.db
      .selectFrom('audit_log')
      .select(['reason_code'])
      .where('subject_id', '=', world.nonAdminHivekeeperId)
      .where('category', '=', 'visibility_denial')
      .executeTakeFirst();
    expect(denial?.reason_code).toBe('cansee_denied');
  });

  it('production engine resolves the recipient via the real repo (deny path proves DB read)', async () => {
    // The production factory wires `participantsRepo.findById` internally; this
    // test exercises a deny path against an existent recipient and asserts the
    // resulting audit row carries the right `reason_code`. Only a real DB read
    // (i.e. NOT the always-allow stub) can resolve `worker_to_other_owner_worker`.
    // The richer spy version (vi.spyOn the repo directly) lives in
    // `domain/visibility/smoke.test.ts` AC-6.
    const logger = createLogger({ level: 'silent' });
    const engine = createVisibilityEngineForProduction({ db: world.db, logger });

    const callerCtx = ctxFor(
      'worker',
      world.workerAgentId,
      world.hiveId,
      world.colonyId,
      world.adminHivekeeperId,
    );
    // Provision a worker owned by the OTHER keeper (forces a deny).
    const otherWorker = 'other-worker-id';
    await world.db
      .insertInto('agents')
      .values({
        id: otherWorker,
        hive_id: world.hiveId,
        colony_id: world.colonyId,
        owner_id: world.nonAdminHivekeeperId,
        name: 'foreign',
        type: 'worker',
        capabilities: '[]',
        instructions: '',
        state: 'active',
        revoked_at: null,
      })
      .execute();

    const allowed = await engine.canSend({ callerContext: callerCtx, recipientId: otherWorker });
    expect(allowed).toBe(false);

    const row = await world.db
      .selectFrom('audit_log')
      .select(['reason_code', 'actor_id'])
      .where('subject_id', '=', otherWorker)
      .executeTakeFirst();
    expect(row?.reason_code).toBe('worker_to_other_owner_worker');
    expect(row?.actor_id).toBe(world.workerAgentId);
  });
});
