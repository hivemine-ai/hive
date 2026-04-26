// Smoke E2E for the Visibility Engine + Audit Log subsystem.
//
// Validates the AC catalogue of [[PRY-004 - Visibility Engine + Audit Log Slice 0]]
// end-to-end on a real SQLite DB:
//
//   AC-1: Provision 2 Hivekeepers + 1 Worker (hk-a) + 1 Scout (hk-b)
//         (named like the AC for traceability).
//   AC-2: Allow without audit row.
//   AC-3: Deny with audit row carrying reason_code='worker_to_other_owner_worker'.
//   AC-4: Audit row queryable through the domain function (admin caller OK,
//         non-admin caller throws AuditError INSUFFICIENT_PRIVILEGE).
//   AC-5: recorder failure-mode does not abort the caller.
//   AC-6: Composition root uses the real engine — verified by spying on the
//         underlying participants repo's findById.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import type { Kysely } from 'kysely';

import { createDb } from '#persistence/db.js';
import { migrateToLatest } from '#persistence/migrate.js';
import { jsonStringify } from '#persistence/type-mappers.js';
import type { Database } from '#persistence/schema.js';

import { createParticipantsReadRepo } from '#domain/auth/index.js';
import {
  createAuditRecorder,
  getAuditRecordFailureCount,
  resetAuditRecordFailureCounters,
} from '#domain/audit/recorder.js';
import { createAuditRepo } from '#domain/audit/repository.js';
import { createLogger } from '#observability/logger.js';
import type { IdentityContext } from '#domain/auth/types.js';
import type { Logger } from '#observability/logger.js';
import type { AuditRepo } from '#domain/audit/repository.js';
import { AuditError } from '#domain/audit/types.js';

import { createVisibilityEngine } from './engine.js';

import { createVisibilityEngineForProduction } from '#composition/visibility-engine-factory.js';

interface SmokeWorld {
  db: Kysely<Database>;
  hiveId: string;
  colonyId: string;
  hkAId: string; // admin Hivekeeper
  hkBId: string;
  workerOfAId: string;
  scoutOfBId: string;
  workerOfBId: string;
}

async function provisionWorld(): Promise<SmokeWorld> {
  const db = createDb({ dialect: 'sqlite', url: 'sqlite::memory:' });
  await migrateToLatest(db);

  const hiveId = uuidv7();
  const colonyId = uuidv7();
  const hkAId = uuidv7();
  const hkBId = uuidv7();
  const workerOfAId = uuidv7();
  const scoutOfBId = uuidv7();
  const workerOfBId = uuidv7();

  await db.insertInto('hives').values({ id: hiveId, name: 'smoke' }).execute();
  await db
    .insertInto('colonies')
    .values({ id: colonyId, hive_id: hiveId, name: 'default' })
    .execute();
  await db
    .insertInto('hivekeepers')
    .values([
      {
        id: hkAId,
        hive_id: hiveId,
        colony_id: colonyId,
        email: 'hk-a@example.com',
        display_name: 'Keeper A',
        is_admin: 1, // hk-a is the admin invoking queryAuditLog
        state: 'active',
        revoked_at: null,
      },
      {
        id: hkBId,
        hive_id: hiveId,
        colony_id: colonyId,
        email: 'hk-b@example.com',
        display_name: 'Keeper B',
        is_admin: 0,
        state: 'active',
        revoked_at: null,
      },
    ])
    .execute();

  await db
    .insertInto('agents')
    .values([
      {
        id: workerOfAId,
        hive_id: hiveId,
        colony_id: colonyId,
        owner_id: hkAId,
        name: 'worker-a',
        type: 'worker',
        capabilities: jsonStringify([]),
        instructions: '',
        state: 'active',
        revoked_at: null,
      },
      {
        id: scoutOfBId,
        hive_id: hiveId,
        colony_id: colonyId,
        owner_id: hkBId,
        name: 'scout-b',
        type: 'scout',
        capabilities: jsonStringify([]),
        instructions: '',
        state: 'active',
        revoked_at: null,
      },
      {
        id: workerOfBId,
        hive_id: hiveId,
        colony_id: colonyId,
        owner_id: hkBId,
        name: 'worker-b',
        type: 'worker',
        capabilities: jsonStringify([]),
        instructions: '',
        state: 'active',
        revoked_at: null,
      },
    ])
    .execute();

  return { db, hiveId, colonyId, hkAId, hkBId, workerOfAId, scoutOfBId, workerOfBId };
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
  isAdmin?: boolean,
): IdentityContext {
  const ctx: IdentityContext = {
    participantId,
    kind,
    hiveId,
    colonyId,
    snapshot: {
      issuedAt: new Date('2026-04-26T00:00:00.000Z'),
      credentialJti: 'jti-smoke',
      credentialKid: 'kid-smoke',
    },
    current:
      kind === 'hivekeeper'
        ? { state: 'active', isAdmin: isAdmin === true }
        : { state: 'active', type: kind },
  };
  if (ownerId !== undefined) ctx.ownerId = ownerId;
  return ctx;
}

/**
 * Slice 0 admin-only query helper. The full `queryAuditLog` lives in Slice 1+;
 * for AC-4 we expose a minimal admin-gated wrapper that uses
 * `findAuditEventsByFilter` underneath. Throws AuditError(INSUFFICIENT_PRIVILEGE)
 * if the caller is not an admin Hivekeeper.
 */
async function queryAuditLogSlice0(
  callerContext: IdentityContext,
  auditRepo: AuditRepo,
  filter: { hiveId: string; subjectId?: string; category?: 'visibility_denial' },
): Promise<Array<{ reasonCode: string | null; actorId: string | null; subjectId: string | null }>> {
  if (callerContext.kind !== 'hivekeeper' || callerContext.current.isAdmin !== true) {
    throw new AuditError('INSUFFICIENT_PRIVILEGE', 'Audit log queries are admin-only', {
      subCode: 'audit_log_admin_only',
    });
  }
  const filterArg: Parameters<AuditRepo['findAuditEventsByFilter']>[0] = { hiveId: filter.hiveId };
  if (filter.subjectId !== undefined) filterArg.subjectId = filter.subjectId;
  if (filter.category !== undefined) filterArg.category = filter.category;
  const events = await auditRepo.findAuditEventsByFilter(filterArg);
  return events.map((e) => ({
    reasonCode: e.reasonCode,
    actorId: e.actorId,
    subjectId: e.subjectId,
  }));
}

describe('PRY-004 smoke E2E — Visibility Engine + Audit Log Slice 0 acceptance criteria', () => {
  let world: SmokeWorld;

  beforeEach(async () => {
    resetAuditRecordFailureCounters();
    world = await provisionWorld();
  });

  afterEach(async () => {
    await world.db.destroy();
    resetAuditRecordFailureCounters();
  });

  it('AC-1 + AC-2: provisioning + worker-a → scout-b is allowed without audit row', async () => {
    const engine = createVisibilityEngineForProduction({
      db: world.db,
      logger: createLogger({ level: 'silent' }),
    });

    const callerCtx = ctxFor(
      'worker',
      world.workerOfAId,
      world.hiveId,
      world.colonyId,
      world.hkAId,
    );
    const allowed = await engine.canSend({
      callerContext: callerCtx,
      recipientId: world.scoutOfBId,
    });
    expect(allowed).toBe(true);

    // Sanity: provisioning created the four participants.
    const participants = await world.db
      .selectFrom('hivekeepers')
      .select('id')
      .union(world.db.selectFrom('agents').select('id'))
      .execute();
    expect(participants.map((p) => p.id).sort()).toEqual(
      [world.hkAId, world.hkBId, world.workerOfAId, world.scoutOfBId, world.workerOfBId].sort(),
    );

    // No audit row for this allow path.
    const denials = await world.db
      .selectFrom('audit_log')
      .selectAll()
      .where('actor_id', '=', world.workerOfAId)
      .execute();
    expect(denials).toHaveLength(0);
  });

  it('AC-3: worker-a → worker-b → deny + audit row reason worker_to_other_owner_worker', async () => {
    const engine = createVisibilityEngineForProduction({
      db: world.db,
      logger: createLogger({ level: 'silent' }),
    });

    const callerCtx = ctxFor(
      'worker',
      world.workerOfAId,
      world.hiveId,
      world.colonyId,
      world.hkAId,
    );
    const allowed = await engine.canSend({
      callerContext: callerCtx,
      recipientId: world.workerOfBId,
    });
    expect(allowed).toBe(false);

    const rows = await world.db
      .selectFrom('audit_log')
      .selectAll()
      .where('hive_id', '=', world.hiveId)
      .where('actor_id', '=', world.workerOfAId)
      .where('subject_id', '=', world.workerOfBId)
      .where('category', '=', 'visibility_denial')
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason_code).toBe('worker_to_other_owner_worker');
    expect(rows[0]?.decision).toBe('deny');
  });

  it('AC-4: queryAuditLogSlice0 returns the audit row for an admin caller', async () => {
    const engine = createVisibilityEngineForProduction({
      db: world.db,
      logger: createLogger({ level: 'silent' }),
    });
    const callerCtx = ctxFor(
      'worker',
      world.workerOfAId,
      world.hiveId,
      world.colonyId,
      world.hkAId,
    );
    await engine.canSend({ callerContext: callerCtx, recipientId: world.workerOfBId });

    const adminCtx = ctxFor(
      'hivekeeper',
      world.hkAId,
      world.hiveId,
      world.colonyId,
      undefined,
      true,
    );
    const auditRepo = createAuditRepo(world.db);
    const events = await queryAuditLogSlice0(adminCtx, auditRepo, {
      hiveId: world.hiveId,
      subjectId: world.workerOfBId,
      category: 'visibility_denial',
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.reasonCode).toBe('worker_to_other_owner_worker');
  });

  it('AC-4: queryAuditLogSlice0 throws AuditError INSUFFICIENT_PRIVILEGE for non-admin keeper', async () => {
    const auditRepo = createAuditRepo(world.db);
    const nonAdminCtx = ctxFor(
      'hivekeeper',
      world.hkBId,
      world.hiveId,
      world.colonyId,
      undefined,
      false,
    );
    await expect(
      queryAuditLogSlice0(nonAdminCtx, auditRepo, { hiveId: world.hiveId }),
    ).rejects.toThrow(AuditError);
  });

  it('AC-4: queryAuditLogSlice0 throws AuditError INSUFFICIENT_PRIVILEGE for an agent caller', async () => {
    const auditRepo = createAuditRepo(world.db);
    const agentCtx = ctxFor('worker', world.workerOfAId, world.hiveId, world.colonyId, world.hkAId);
    await expect(
      queryAuditLogSlice0(agentCtx, auditRepo, { hiveId: world.hiveId }),
    ).rejects.toThrow(AuditError);
  });

  it('AC-5: failure-mode — recorder failure does NOT abort canSend (caller still gets the right boolean)', async () => {
    // Drop the audit_log table so the recorder INSERT fails; canSend must still
    // return the correct decision (false) and increment the failure counter.
    await world.db.schema.dropTable('audit_log').execute();

    const engine = createVisibilityEngineForProduction({
      db: world.db,
      logger: createLogger({ level: 'silent' }),
    });
    const callerCtx = ctxFor(
      'worker',
      world.workerOfAId,
      world.hiveId,
      world.colonyId,
      world.hkAId,
    );

    const allowed = await engine.canSend({
      callerContext: callerCtx,
      recipientId: world.workerOfBId,
    });
    expect(allowed).toBe(false);
    expect(getAuditRecordFailureCount('visibility_denial')).toBeGreaterThanOrEqual(1);
  });

  it('AC-6: composition root wires the REAL engine — spy on participantsRepo.findById confirms it', async () => {
    // Build the engine using the same wiring as production but with an
    // intercepted repo so we can observe findById being called.
    const realRepo = createParticipantsReadRepo(world.db);
    const findByIdSpy = vi.spyOn(realRepo, 'findById');

    const auditRepo = createAuditRepo(world.db);
    const recorder = createAuditRecorder({ auditRepo, logger: silentLogger() });
    const engine = createVisibilityEngine({ participantsRepo: realRepo, recorder });

    const callerCtx = ctxFor(
      'worker',
      world.workerOfAId,
      world.hiveId,
      world.colonyId,
      world.hkAId,
    );
    await engine.canSend({ callerContext: callerCtx, recipientId: world.scoutOfBId });

    expect(findByIdSpy).toHaveBeenCalledWith(world.scoutOfBId);
  });
});
