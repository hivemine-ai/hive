// ADR-026 enrollment retention job: retirement, end of grace and Worker token row purge,
// with a fake clock. SQLite by default; set HIVE_TEST_PG_URL to run the same suite against
// Postgres (CI `postgres` job), where the concurrency tests race real transactions.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { v7 as uuidv7 } from 'uuid';

import type { NewAuditEvent } from '#domain/audit/index.js';
import type { Logger } from '#observability/logger.js';
import { dateToIso, jsonStringify } from '#persistence/type-mappers.js';
import { destroyWorld, seedWorld, type SeedWorld } from '../test-helpers.js';
import type { CallerContext } from '../caller-context.js';
import type { CellsRepoHook } from './cells-hook.js';
import { createParticipantStateSignal } from './state-signal.js';
import type { ParticipantStateChange } from './state-signal.js';
import { createEnrollmentRetention } from './retention.js';
import type { EnrollmentRetention, EnrollmentRetentionDeps } from './retention.js';

const PG_URL = process.env['HIVE_TEST_PG_URL'];
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-06T12:00:00.000Z');
const SYSTEM: CallerContext = { kind: 'system' };
const NOBODY_LIVE = { isHolderLive: () => false };

describe(`runEnrollmentRetention (${PG_URL ? 'postgres' : 'sqlite'})`, () => {
  let world: SeedWorld;
  let audits: NewAuditEvent[];
  let signals: ParticipantStateChange[];
  let closedCells: string[];
  let retention: EnrollmentRetention;
  const enrollmentJti = uuidv7();

  function build(overrides: Partial<EnrollmentRetentionDeps> = {}): EnrollmentRetention {
    const stateSignal = createParticipantStateSignal();
    stateSignal.onParticipantStateChanged((change) => signals.push(change));
    const cellsHook: CellsRepoHook = {
      createCell: () => Promise.resolve(),
      closeCell: (_executor, input) => {
        closedCells.push(input.ownerId);
        return Promise.resolve();
      },
      closeCellsByOwner: () => Promise.resolve(),
    };
    return createEnrollmentRetention({
      db: world.db,
      retentionDays: 30,
      graceDays: 60,
      holderProofWindowDays: 7,
      cellsHook,
      stateSignal,
      auditRecorder: {
        recordEvent: (event) => {
          audits.push(event);
          return Promise.resolve();
        },
      },
      ...overrides,
    });
  }

  beforeEach(async () => {
    world = await seedWorld({ pgUrl: PG_URL });
    audits = [];
    signals = [];
    closedCells = [];
    retention = build();
  });

  afterEach(async () => {
    await destroyWorld(world);
  });

  async function insertAgent(input: {
    name: string;
    origin?: 'manual' | 'enrollment';
    state?: 'active' | 'retired' | 'suspended';
    lastConnectedAt?: Date | null;
    createdAt?: Date;
    retiredAt?: Date | null;
  }): Promise<string> {
    const id = uuidv7();
    const origin = input.origin ?? 'enrollment';
    await world.db
      .insertInto('agents')
      .values({
        id,
        hive_id: world.hiveId,
        colony_id: world.colonyId,
        owner_id: world.nonAdminHivekeeperId,
        name: input.name,
        type: 'worker',
        capabilities: jsonStringify([]),
        instructions: '',
        state: input.state ?? 'active',
        revoked_at: null,
        created_at: dateToIso(input.createdAt ?? new Date(NOW.getTime() - 100 * DAY_MS)),
        last_connected_at:
          input.lastConnectedAt === null || input.lastConnectedAt === undefined
            ? null
            : dateToIso(input.lastConnectedAt),
        origin,
        enrolled_via: origin === 'enrollment' ? enrollmentJti : null,
        retired_at:
          input.retiredAt === null || input.retiredAt === undefined
            ? null
            : dateToIso(input.retiredAt),
      })
      .execute();
    return id;
  }

  async function agentRow(id: string) {
    return world.db
      .selectFrom('agents')
      .select(['state', 'retired_at', 'revoked_at'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  }

  function daysAgo(days: number): Date {
    return new Date(NOW.getTime() - days * DAY_MS);
  }

  describe('pass 1: retirement', () => {
    it('retires an enrollment Agent offline beyond the retention, with agent_retired by system', async () => {
      const stale = await insertAgent({ name: 'stale', lastConnectedAt: daysAgo(31) });

      const result = await retention.runEnrollmentRetention(NOW, SYSTEM, NOBODY_LIVE);

      expect(result.retiredAgentIds).toEqual([stale]);
      const row = await agentRow(stale);
      expect(row.state).toBe('retired');
      expect(new Date(row.retired_at as string).getTime()).toBe(NOW.getTime());
      expect(audits).toEqual([
        expect.objectContaining({
          category: 'agent_retired',
          decision: 'success',
          actorId: null,
          actorKind: 'system',
          subjectId: stale,
          subjectKind: 'participant',
          hiveId: world.hiveId,
          detail: { lastConnectedAt: daysAgo(31).toISOString(), retentionDays: 30 },
        }),
      ]);
      expect(signals).toEqual([{ participantId: stale, newState: 'retired' }]);
    });

    it('leaves a manual Agent in the same condition untouched', async () => {
      const manual = await insertAgent({
        name: 'manual',
        origin: 'manual',
        lastConnectedAt: daysAgo(400),
      });

      const result = await retention.runEnrollmentRetention(NOW, SYSTEM, NOBODY_LIVE);

      expect(result.retiredAgentIds).toEqual([]);
      expect((await agentRow(manual)).state).toBe('active');
    });

    it('keeps an Agent connected within the retention and uses created_at when it never connected', async () => {
      const recent = await insertAgent({ name: 'recent', lastConnectedAt: daysAgo(29) });
      const neverOld = await insertAgent({
        name: 'never-old',
        lastConnectedAt: null,
        createdAt: daysAgo(31),
      });
      const neverNew = await insertAgent({
        name: 'never-new',
        lastConnectedAt: null,
        createdAt: daysAgo(2),
      });

      const result = await retention.runEnrollmentRetention(NOW, SYSTEM, NOBODY_LIVE);

      expect(result.retiredAgentIds).toEqual([neverOld]);
      expect((await agentRow(recent)).state).toBe('active');
      expect((await agentRow(neverNew)).state).toBe('active');
    });

    it('never retires a live holder, however old its last_connected_at', async () => {
      const live = await insertAgent({ name: 'live', lastConnectedAt: daysAgo(90) });
      const offline = await insertAgent({ name: 'offline', lastConnectedAt: daysAgo(90) });

      const result = await retention.runEnrollmentRetention(NOW, SYSTEM, {
        isHolderLive: (id) => id === live,
      });

      expect(result.retiredAgentIds).toEqual([offline]);
      expect((await agentRow(live)).state).toBe('active');
    });

    it('does not retire a suspended Agent', async () => {
      const suspended = await insertAgent({
        name: 'paused',
        state: 'suspended',
        lastConnectedAt: daysAgo(90),
      });

      await retention.runEnrollmentRetention(NOW, SYSTEM, NOBODY_LIVE);

      expect((await agentRow(suspended)).state).toBe('suspended');
    });

    it('does nothing with HIVE_ENROLLMENT_RETENTION_DAYS = 0', async () => {
      const stale = await insertAgent({ name: 'stale', lastConnectedAt: daysAgo(400) });
      retention = build({ retentionDays: 0 });

      const result = await retention.runEnrollmentRetention(NOW, SYSTEM, NOBODY_LIVE);

      expect(result.retiredAgentIds).toEqual([]);
      expect((await agentRow(stale)).state).toBe('active');
    });

    it('is idempotent: a second run retires nothing more and emits nothing', async () => {
      await insertAgent({ name: 'stale', lastConnectedAt: daysAgo(31) });
      await retention.runEnrollmentRetention(NOW, SYSTEM, NOBODY_LIVE);
      audits = [];
      signals = [];

      const again = await retention.runEnrollmentRetention(NOW, SYSTEM, NOBODY_LIVE);

      expect(again.retiredAgentIds).toEqual([]);
      expect(audits).toEqual([]);
      expect(signals).toEqual([]);
    });

    // SQLite has one connection: the refresh queued from the liveness callback (between the
    // candidate read and the conditional UPDATE) runs before the UPDATE.
    it.skipIf(PG_URL)(
      'loses to a claim that refreshed last_connected_at after the candidates were read',
      async () => {
        const raced = await insertAgent({ name: 'raced', lastConnectedAt: daysAgo(31) });
        const result = await retention.runEnrollmentRetention(NOW, SYSTEM, {
          isHolderLive: () => {
            void world.db
              .updateTable('agents')
              .set({ last_connected_at: dateToIso(NOW) })
              .where('id', '=', raced)
              .execute();
            return false;
          },
        });
        expect(result.retiredAgentIds).toEqual([]);
        expect((await agentRow(raced)).state).toBe('active');
        expect(audits).toEqual([]);
      },
    );

    // Postgres: a claim holds the row with its refresh uncommitted; the retire UPDATE
    // blocks on it and re-evaluates its predicate after the commit. Exactly one winner.
    it.runIf(PG_URL)(
      'loses to a concurrent claim transaction that commits while the retire UPDATE waits',
      async () => {
        const raced = await insertAgent({ name: 'raced', lastConnectedAt: daysAgo(31) });
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let locked!: () => void;
        const rowLocked = new Promise<void>((resolve) => (locked = resolve));
        const claim = world.db.transaction().execute(async (trx) => {
          await trx
            .updateTable('agents')
            .set({ last_connected_at: dateToIso(NOW) })
            .where('id', '=', raced)
            .execute();
          locked();
          await gate;
        });
        await rowLocked;

        const run = retention.runEnrollmentRetention(NOW, SYSTEM, NOBODY_LIVE);
        await new Promise((resolve) => setTimeout(resolve, 300));
        release();
        await claim;
        const result = await run;

        expect(result.retiredAgentIds).toEqual([]);
        expect((await agentRow(raced)).state).toBe('active');
        expect(audits).toEqual([]);
      },
    );
  });

  describe('pass 2: end of grace', () => {
    it('revokes a retired Agent past the grace by the revokeAgent transition, Cell closed', async () => {
      const expired = await insertAgent({
        name: 'expired',
        state: 'retired',
        lastConnectedAt: daysAgo(95),
        retiredAt: daysAgo(61),
      });
      const inGrace = await insertAgent({
        name: 'in-grace',
        state: 'retired',
        lastConnectedAt: daysAgo(40),
        retiredAt: daysAgo(10),
      });

      const result = await retention.runEnrollmentRetention(NOW, SYSTEM, NOBODY_LIVE);

      expect(result.revokedAgentIds).toEqual([expired]);
      const row = await agentRow(expired);
      expect(row.state).toBe('revoked');
      expect(row.retired_at).toBeNull();
      expect(new Date(row.revoked_at as string).getTime()).toBe(NOW.getTime());
      expect((await agentRow(inGrace)).state).toBe('retired');
      expect(closedCells).toEqual([expired]);
      expect(audits).toEqual([
        expect.objectContaining({
          category: 'admin_agent_revoke',
          decision: 'success',
          actorId: null,
          actorKind: 'system',
          subjectId: expired,
          subjectKind: 'participant',
          reasonCode: 'enrollment_grace_expired',
          detail: { retiredAt: daysAgo(61).toISOString(), graceDays: 60 },
        }),
      ]);
      expect(signals).toEqual([{ participantId: expired, newState: 'revoked' }]);
    });

    it('frees the name: a new Agent with the same name and owner can be inserted', async () => {
      await insertAgent({
        name: 'reused',
        state: 'retired',
        lastConnectedAt: daysAgo(95),
        retiredAt: daysAgo(61),
      });
      await retention.runEnrollmentRetention(NOW, SYSTEM, NOBODY_LIVE);

      await expect(insertAgent({ name: 'reused', lastConnectedAt: NOW })).resolves.toEqual(
        expect.any(String),
      );
    });

    it('keeps retired Agents indefinitely with HIVE_ENROLLMENT_GRACE_DAYS = 0', async () => {
      const old = await insertAgent({
        name: 'old',
        state: 'retired',
        lastConnectedAt: daysAgo(900),
        retiredAt: daysAgo(800),
      });
      retention = build({ graceDays: 0 });

      const result = await retention.runEnrollmentRetention(NOW, SYSTEM, NOBODY_LIVE);

      expect(result.revokedAgentIds).toEqual([]);
      expect((await agentRow(old)).state).toBe('retired');
    });

    it('does not revoke in the run that retires: the grace starts at retired_at', async () => {
      const stale = await insertAgent({ name: 'stale', lastConnectedAt: daysAgo(400) });

      const result = await retention.runEnrollmentRetention(NOW, SYSTEM, NOBODY_LIVE);

      expect(result).toMatchObject({ retiredAgentIds: [stale], revokedAgentIds: [] });
    });
  });

  describe('pass 3: Worker token rows', () => {
    async function insertToken(enrolledVia: string | null, expiresAt: Date): Promise<string> {
      const jti = uuidv7();
      await world.db
        .insertInto('credentials')
        .values({
          jti,
          participant_id: world.workerAgentId,
          participant_kind: 'worker',
          kid: world.signingKey.kid,
          expires_at: dateToIso(expiresAt),
          snapshot: jsonStringify({}),
          issued_by: null,
          revoked_at: null,
          enrolled_via: enrolledVia,
        })
        .execute();
      return jti;
    }

    it('deletes Worker token rows past the holder-proof window and keeps the rest', async () => {
      const dead = await insertToken(enrollmentJti, daysAgo(8));
      const inWindow = await insertToken(enrollmentJti, daysAgo(6));
      const manual = await insertToken(null, daysAgo(400));

      const result = await retention.runEnrollmentRetention(NOW, SYSTEM, NOBODY_LIVE);

      expect(result.purgedTokenRows).toBe(1);
      const left = await world.db.selectFrom('credentials').select('jti').execute();
      const jtis = left.map((r) => r.jti);
      expect(jtis).not.toContain(dead);
      expect(jtis).toEqual(expect.arrayContaining([inWindow, manual]));
    });
  });

  it.each([
    ['negative', -1],
    ['NaN', Number.NaN],
  ])('warns on a %s retention or grace and treats it as disabled', async (_label, value) => {
    const stale = await insertAgent({ name: 'stale', lastConnectedAt: daysAgo(400) });
    const expired = await insertAgent({
      name: 'expired',
      state: 'retired',
      lastConnectedAt: daysAgo(900),
      retiredAt: daysAgo(800),
    });
    const warn = vi.fn();
    retention = build({
      retentionDays: value,
      graceDays: value,
      logger: { warn } as unknown as Pick<Logger, 'warn'>,
    });

    const result = await retention.runEnrollmentRetention(NOW, SYSTEM, NOBODY_LIVE);

    expect(result).toMatchObject({ retiredAgentIds: [], revokedAgentIds: [] });
    expect((await agentRow(stale)).state).toBe('active');
    expect((await agentRow(expired)).state).toBe('retired');
    for (const name of ['HIVE_ENROLLMENT_RETENTION_DAYS', 'HIVE_ENROLLMENT_GRACE_DAYS']) {
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'auth_enrollment_retention_config_invalid', name }),
        expect.any(String),
      );
    }
  });

  it('refuses an authenticated caller that is not an admin', async () => {
    const caller = {
      kind: 'authenticated',
      identity: { current: { isAdmin: false }, kind: 'hivekeeper', snapshot: {} },
    } as unknown as CallerContext;

    await expect(retention.runEnrollmentRetention(NOW, caller, NOBODY_LIVE)).rejects.toMatchObject({
      code: 'INSUFFICIENT_PRIVILEGE',
    });
  });

  it('tags a failing pass so the scheduler can log it', async () => {
    await world.db.schema.dropTable('agents').execute();

    await expect(retention.runEnrollmentRetention(NOW, SYSTEM, NOBODY_LIVE)).rejects.toMatchObject({
      name: 'EnrollmentRetentionPassError',
      pass: 'retire',
    });
  });
});
