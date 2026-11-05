// ADR-026 rotation vs revocation of an enrollment credential, the revocation cascade,
// promotion to Scout and the purge rules. Runs against SQLite by default; set
// HIVE_TEST_PG_URL to run the same suite against Postgres (CI `postgres` job).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CallerContext } from '../caller-context.js';
import type { AuthError, AuthErrorCode } from '../errors.js';
import { destroyWorld, seedWorld, type SeedWorld } from '../test-helpers.js';
import type { IdentityContext, IssuedCredential } from '../types.js';
import type { CellsRepoHook } from '#domain/auth/participants/cells-hook.js';
import { createParticipantsReadRepo } from '#domain/auth/participants/repository.js';
import { createParticipantsWriteRepo } from '#domain/auth/participants/repository.write.js';
import { createParticipantStateSignal } from '#domain/auth/participants/state-signal.js';
import type { ParticipantStateChange } from '#domain/auth/participants/state-signal.js';
import { dateToIso } from '#persistence/type-mappers.js';
import { createBlocklist } from './blocklist.js';
import { createEnrollment } from './enrollment.js';
import type { Enrollment } from './enrollment.js';
import { createIssuer } from './issuer.js';
import { createRevoker } from './revoker.js';
import type { Revoker } from './revoker.js';
import { createRotator } from './rotator.js';
import type { Rotator } from './rotator.js';
import { createVerifier } from './verifier.js';
import type { Verifier } from './verifier.js';
import { purgeExpiredWorkerTokens } from './worker-tokens.js';

const PG_URL = process.env['HIVE_TEST_PG_URL'];
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// Second-aligned and current, because `verify` reads the real clock.
const T0 = new Date(Math.floor(Date.now() / 1000) * 1000);
const SYSTEM: CallerContext = { kind: 'system' };

async function expectAuthError(
  promise: Promise<unknown>,
  code: AuthErrorCode,
  subCode?: string,
): Promise<void> {
  try {
    await promise;
    expect.fail(`expected AuthError(${code})`);
  } catch (err) {
    // Compared by name: the write repository comes from `dist/` through its #alias, so its
    // AuthError is another class instance than the one of `src/`.
    expect((err as Error).name).toBe('AuthError');
    const e = err as AuthError;
    expect(e.code).toBe(code);
    if (subCode !== undefined) expect(e.subCode).toBe(subCode);
  }
}

describe(`enrollment cascade (${PG_URL ? 'postgres' : 'sqlite'})`, () => {
  let world: SeedWorld;
  let clock: Date;
  let enrollment: Enrollment;
  let verifier: Verifier;
  let rotator: Rotator;
  let revoker: Revoker;
  let closedCells: string[];
  let stateChanges: ParticipantStateChange[];
  let cellsHook: CellsRepoHook;

  beforeEach(async () => {
    world = await seedWorld({ pgUrl: PG_URL });
    clock = T0;
    closedCells = [];
    stateChanges = [];
    cellsHook = {
      createCell: () => Promise.resolve(),
      closeCell: (_executor, input) => {
        closedCells.push(input.ownerId);
        return Promise.resolve();
      },
      closeCellsByOwner: () => Promise.resolve(),
    };
    const stateSignal = createParticipantStateSignal();
    stateSignal.onParticipantStateChanged((change) => stateChanges.push(change));
    const participantsRepo = createParticipantsReadRepo(world.db);
    const blocklist = createBlocklist(world.db);
    enrollment = createEnrollment({
      signingKey: world.signingKey,
      participantsRepo,
      hiveStableIdentifier: world.hiveId,
      db: world.db,
      dialect: PG_URL ? 'postgres' : 'sqlite',
      now: () => clock,
      enrollmentTtlMs: 90 * DAY_MS,
      hiveMaxAgents: 10,
      workerTokenTtlMs: HOUR_MS,
    });
    verifier = createVerifier({
      signingKeys: new Map([[world.signingKey.kid, world.signingKey]]),
      blocklist,
      participantsRepo,
      hiveStableIdentifier: world.hiveId,
    });
    rotator = createRotator({
      signingKey: world.signingKey,
      blocklist,
      hiveStableIdentifier: world.hiveId,
      defaultTtlMs: 365 * DAY_MS,
      enrollmentTtlMs: 90 * DAY_MS,
      db: world.db,
      now: () => clock,
    });
    revoker = createRevoker({ db: world.db, now: () => clock, cellsHook, stateSignal });
  });

  afterEach(async () => {
    await destroyWorld(world);
  });

  async function issueEnrollment(): Promise<IssuedCredential> {
    return enrollment.issueEnrollmentCredential(
      { ownerId: world.nonAdminHivekeeperId, namePrefix: 'ci-', maxAgents: 4 },
      SYSTEM,
    );
  }

  async function register(
    enrollmentJwt: string,
    name: string,
  ): Promise<{ agentId: string; token: IssuedCredential }> {
    const identity: IdentityContext = await verifier.verify(`Bearer ${enrollmentJwt}`);
    const { agent, token } = await enrollment.createEnrolledAgent(
      {
        ownerId: identity.participantId,
        name,
        description: 'test agent',
        enrolledVia: identity.snapshot.credentialJti,
      },
      identity,
    );
    return { agentId: agent.id, token };
  }

  async function revocationReason(jti: string): Promise<string | null | undefined> {
    const row = await world.db
      .selectFrom('credential_revocations')
      .select('reason')
      .where('jti', '=', jti)
      .executeTakeFirst();
    return row === undefined ? undefined : row.reason;
  }

  async function agentState(agentId: string): Promise<string> {
    const row = await world.db
      .selectFrom('agents')
      .select('state')
      .where('id', '=', agentId)
      .executeTakeFirstOrThrow();
    return row.state;
  }

  describe('rotation', () => {
    it('issues an enrollment with the same scope and limits and a 90-day default TTL', async () => {
      const old = await issueEnrollment();
      const rotated = await rotator.rotateCredential({ currentJti: old.jti });

      expect(rotated.expiresAt).toEqual(new Date(T0.getTime() + 90 * DAY_MS));
      const identity = await verifier.verify(`Bearer ${rotated.jwt}`);
      expect(identity.snapshot).toMatchObject({ scope: 'enroll', namePrefix: 'ci-', maxAgents: 4 });
      const row = await world.db
        .selectFrom('credentials')
        .select('scope')
        .where('jti', '=', rotated.jti)
        .executeTakeFirstOrThrow();
      expect(row.scope).toBe('enroll');
      expect(await revocationReason(old.jti)).toBe('rotation');
    });

    it('keeps renewals of child tokens working while new registrations with it fail', async () => {
      const old = await issueEnrollment();
      const { agentId, token } = await register(old.jwt, 'ci-one');
      await rotator.rotateCredential({ currentJti: old.jti });

      const renewed = await enrollment.issueWorkerToken({
        agentId,
        mode: 'renew',
        presentedJti: token.jti,
      });
      expect(renewed.jti).not.toBe(token.jti);
      await expectAuthError(verifier.verify(`Bearer ${old.jwt}`), 'CREDENTIAL_REVOKED');
      await expectAuthError(
        enrollment.issueWorkerToken({ agentId, mode: 'claim', enrolledVia: old.jti }),
        'CREDENTIAL_REVOKED',
      );
    });

    it('still rotates a full credential into a full credential', async () => {
      const issuer = createIssuer({
        signingKey: world.signingKey,
        participantsRepo: createParticipantsReadRepo(world.db),
        hiveStableIdentifier: world.hiveId,
        defaultTtlMs: 365 * DAY_MS,
        db: world.db,
      });
      const full = await issuer.issueCredential({ participantId: world.adminHivekeeperId });
      const rotated = await rotator.rotateCredential({ currentJti: full.jti });
      const identity = await verifier.verify(`Bearer ${rotated.jwt}`);
      expect(identity.snapshot.scope).toBeUndefined();
      expect(identity.current.isAdmin).toBe(true);
      expect(rotated.expiresAt).toEqual(new Date(T0.getTime() + 365 * DAY_MS));
    });
  });

  describe('revocation', () => {
    it('blocklists every child token, including the original token of a re-bound stream', async () => {
      const cred = await issueEnrollment();
      const { agentId, token: original } = await register(cred.jwt, 'ci-one');
      const renewed = await enrollment.issueWorkerToken({
        agentId,
        mode: 'renew',
        presentedJti: original.jti,
      });
      const { token: other } = await register(cred.jwt, 'ci-two');

      const result = await revoker.revokeCredential({
        jti: cred.jti,
        revokedBy: world.nonAdminHivekeeperId,
        reason: 'suspected leak',
      });

      expect(new Set(result.revokedTokenJtis)).toEqual(
        new Set([original.jti, renewed.jti, other.jti]),
      );
      expect(result.revokedAgentIds).toEqual([]);
      for (const jti of [original.jti, renewed.jti, other.jti]) {
        expect(await revocationReason(jti)).toBe('enrollment_revoked');
      }
      expect(await revocationReason(cred.jti)).toBe('suspected leak');
      expect(await agentState(agentId)).toBe('active');
      await expectAuthError(
        enrollment.issueWorkerToken({ agentId, mode: 'renew', presentedJti: renewed.jti }),
        'CREDENTIAL_REVOKED',
      );
    });

    it('covers child tokens expired inside the holder-proof window, not older ones', async () => {
      const cred = await issueEnrollment();
      const { agentId, token: stale } = await register(cred.jwt, 'ci-one');
      clock = new Date(T0.getTime() + 10 * DAY_MS);
      const recent = await enrollment.issueWorkerToken({
        agentId,
        mode: 'claim',
        enrolledVia: cred.jti,
      });
      clock = new Date(clock.getTime() + 3 * DAY_MS);

      const result = await revoker.revokeCredential({
        jti: cred.jti,
        revokedBy: world.nonAdminHivekeeperId,
      });

      expect(result.revokedTokenJtis).toEqual([recent.jti]);
      expect(await revocationReason(stale.jti)).toBeUndefined();
    });

    it('a rotated enrollment revoked later turns the rotation row into a revocation and cuts renewals', async () => {
      const cred = await issueEnrollment();
      const { agentId, token } = await register(cred.jwt, 'ci-one');
      await rotator.rotateCredential({ currentJti: cred.jti });

      const result = await revoker.revokeCredential({
        jti: cred.jti,
        revokedBy: world.nonAdminHivekeeperId,
        reason: 'leaked after rotation',
      });

      expect(result.revokedTokenJtis).toEqual([token.jti]);
      expect(await revocationReason(cred.jti)).toBe('leaked after rotation');
      await expectAuthError(
        enrollment.issueWorkerToken({ agentId, mode: 'renew', presentedJti: token.jti }),
        'CREDENTIAL_REVOKED',
      );
    });

    it('with revokeAgents, moves active, retired and suspended Agents of the enrollment to revoked', async () => {
      const cred = await issueEnrollment();
      const { agentId: active } = await register(cred.jwt, 'ci-active');
      const { agentId: retired } = await register(cred.jwt, 'ci-retired');
      const { agentId: suspended } = await register(cred.jwt, 'ci-suspended');
      await world.db
        .updateTable('agents')
        .set({ state: 'retired', retired_at: dateToIso(clock) })
        .where('id', '=', retired)
        .execute();
      await world.db
        .updateTable('agents')
        .set({ state: 'suspended' })
        .where('id', '=', suspended)
        .execute();

      const result = await revoker.revokeCredential({
        jti: cred.jti,
        revokedBy: world.nonAdminHivekeeperId,
        revokeAgents: true,
      });

      expect(new Set(result.revokedAgentIds)).toEqual(new Set([active, retired, suspended]));
      for (const id of [active, retired, suspended]) expect(await agentState(id)).toBe('revoked');
      expect(new Set(closedCells)).toEqual(new Set([active, retired, suspended]));
      expect(
        stateChanges
          .filter((c) => c.newState === 'revoked')
          .map((c) => c.participantId)
          .sort(),
      ).toEqual([active, retired, suspended].sort());
      expect(await agentState(world.workerAgentId)).toBe('active');
      const freed = await register((await issueEnrollment()).jwt, 'ci-active');
      expect(freed.agentId).not.toBe(active);
    });

    it('rejects revokeAgents on a credential that is not an enrollment', async () => {
      const issuer = createIssuer({
        signingKey: world.signingKey,
        participantsRepo: createParticipantsReadRepo(world.db),
        hiveStableIdentifier: world.hiveId,
        defaultTtlMs: HOUR_MS,
        db: world.db,
      });
      const full = await issuer.issueCredential({ participantId: world.workerAgentId });
      await expectAuthError(
        revoker.revokeCredential({
          jti: full.jti,
          revokedBy: world.adminHivekeeperId,
          revokeAgents: true,
        }),
        'INVALID_INPUT',
        'revoke_agents_requires_enrollment',
      );
      expect(await revocationReason(full.jti)).toBeUndefined();
    });
  });

  describe('promotion to Scout', () => {
    it('converts an enrollment Worker to manual and revokes its Worker tokens', async () => {
      const cred = await issueEnrollment();
      const { agentId, token } = await register(cred.jwt, 'ci-one');
      const writeRepo = createParticipantsWriteRepo(world.db, { now: () => clock });

      await writeRepo.changeAgentType(agentId, 'scout', SYSTEM);

      const row = await world.db
        .selectFrom('agents')
        .select(['type', 'origin', 'enrolled_via', 'last_worker_jti', 'state'])
        .where('id', '=', agentId)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({
        type: 'scout',
        origin: 'manual',
        enrolled_via: null,
        last_worker_jti: null,
        state: 'active',
      });
      expect(await revocationReason(token.jti)).toBe('origin_changed');
      await expectAuthError(verifier.verify(`Bearer ${token.jwt}`), 'CREDENTIAL_REVOKED');
    });

    it('changes only the type of a manual Agent', async () => {
      const writeRepo = createParticipantsWriteRepo(world.db);
      await writeRepo.changeAgentType(world.workerAgentId, 'scout', SYSTEM);
      const row = await world.db
        .selectFrom('agents')
        .select(['type', 'origin'])
        .where('id', '=', world.workerAgentId)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ type: 'scout', origin: 'manual' });
    });

    it('refuses a retired or revoked Agent', async () => {
      const cred = await issueEnrollment();
      const { agentId } = await register(cred.jwt, 'ci-one');
      const writeRepo = createParticipantsWriteRepo(world.db);
      await world.db
        .updateTable('agents')
        .set({ state: 'retired', retired_at: dateToIso(clock) })
        .where('id', '=', agentId)
        .execute();
      await expectAuthError(
        writeRepo.changeAgentType(agentId, 'scout', SYSTEM),
        'INVALID_STATE_TRANSITION',
        'agent_retired_cannot_change_type',
      );
      await world.db
        .updateTable('agents')
        .set({ state: 'revoked', retired_at: null })
        .where('id', '=', agentId)
        .execute();
      await expectAuthError(
        writeRepo.changeAgentType(agentId, 'scout', SYSTEM),
        'INVALID_STATE_TRANSITION',
        'agent_revoked_cannot_change_type',
      );
    });
  });

  describe('purge', () => {
    it('keeps blocklist rows and Worker token rows inside the holder-proof window', async () => {
      const cred = await issueEnrollment();
      const { agentId, token: oldToken } = await register(cred.jwt, 'ci-one');
      await enrollment.issueWorkerToken({ agentId, mode: 'claim', enrolledVia: cred.jti });
      const blocklist = createBlocklist(world.db);

      // oldToken expired 6 days ago: still a possible holder proof.
      const insideWindow = new Date(oldToken.expiresAt.getTime() + 6 * DAY_MS);
      expect(await blocklist.purgeExpired(insideWindow)).toBe(0);
      expect(await purgeExpiredWorkerTokens(world.db, insideWindow)).toBe(0);

      const beyondWindow = new Date(oldToken.expiresAt.getTime() + 7 * DAY_MS + 6_000);
      expect(await blocklist.purgeExpired(beyondWindow)).toBeGreaterThanOrEqual(1);
      expect(await revocationReason(oldToken.jti)).toBeUndefined();
      expect(await purgeExpiredWorkerTokens(world.db, beyondWindow)).toBe(2);
      const enrollmentRow = await world.db
        .selectFrom('credentials')
        .select('jti')
        .where('jti', '=', cred.jti)
        .executeTakeFirst();
      expect(enrollmentRow?.jti).toBe(cred.jti);
    });
  });
});
