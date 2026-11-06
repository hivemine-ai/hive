// ADR-026 Worker tokens: issueWorkerToken (create / claim / revive / renew) and
// verifyRenewalBearer (holder proof). Runs against SQLite by default; set HIVE_TEST_PG_URL
// to run the same suite against Postgres (CI `postgres` job), where the concurrent
// renewal test races two real transactions.

import * as jose from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isAuthError } from '../errors.js';
import type { AuthError, AuthErrorCode } from '../errors.js';
import { destroyWorld, seedWorld, type SeedWorld } from '../test-helpers.js';
import type { IssuedCredential } from '../types.js';
import { createParticipantsReadRepo } from '#domain/auth/participants/repository.js';
import { dateToIso } from '#persistence/type-mappers.js';
import { createBlocklist } from './blocklist.js';
import { createEnrollment } from './enrollment.js';
import type { Enrollment } from './enrollment.js';
import { createIssuer } from './issuer.js';
import { createVerifier } from './verifier.js';
import type { Verifier } from './verifier.js';

const PG_URL = process.env['HIVE_TEST_PG_URL'];

const SECOND_MS = 1000;
const HOUR_MS = 60 * 60 * SECOND_MS;
const DAY_MS = 24 * HOUR_MS;
// Second-aligned (JWT times are whole seconds) and current, because `verify` reads the
// real clock.
const T0 = new Date(Math.floor(Date.now() / 1000) * 1000);

async function expectAuthError(
  promise: Promise<unknown>,
  code: AuthErrorCode,
  subCode?: string,
): Promise<void> {
  try {
    await promise;
    expect.fail(`expected AuthError(${code})`);
  } catch (err) {
    expect(isAuthError(err)).toBe(true);
    const e = err as AuthError;
    expect(e.code).toBe(code);
    if (subCode !== undefined) expect(e.subCode).toBe(subCode);
  }
}

describe(`Worker tokens (${PG_URL ? 'postgres' : 'sqlite'})`, () => {
  let world: SeedWorld;
  let clock: Date;
  let enrollment: Enrollment;
  let verifier: Verifier;
  let enrollmentJti: string;
  let agentId: string;

  function buildVerifier(holderProofWindowDays?: number): Verifier {
    return createVerifier({
      signingKeys: new Map([[world.signingKey.kid, world.signingKey]]),
      blocklist: createBlocklist(world.db),
      participantsRepo: createParticipantsReadRepo(world.db),
      hiveStableIdentifier: world.hiveId,
      db: world.db,
      now: () => clock,
      ...(holderProofWindowDays !== undefined ? { holderProofWindowDays } : {}),
    });
  }

  beforeEach(async () => {
    world = await seedWorld({ pgUrl: PG_URL });
    clock = T0;
    enrollment = createEnrollment({
      signingKey: world.signingKey,
      participantsRepo: createParticipantsReadRepo(world.db),
      hiveStableIdentifier: world.hiveId,
      db: world.db,
      now: () => clock,
      enrollmentTtlMs: 90 * DAY_MS,
      hiveMaxAgents: 10,
      workerTokenTtlMs: HOUR_MS,
    });
    verifier = buildVerifier();
    const issued = await enrollment.issueEnrollmentCredential(
      { ownerId: world.adminHivekeeperId },
      { kind: 'system' },
    );
    enrollmentJti = issued.jti;
    agentId = world.workerAgentId;
    // The seeded Worker stands in for an Agent created by register_session.
    await world.db
      .updateTable('agents')
      .set({ origin: 'enrollment', enrolled_via: enrollmentJti })
      .where('id', '=', agentId)
      .execute();
  });

  afterEach(async () => {
    await destroyWorld(world);
  });

  async function agentRow() {
    return world.db
      .selectFrom('agents')
      .select(['last_worker_jti', 'last_connected_at'])
      .where('id', '=', agentId)
      .executeTakeFirstOrThrow();
  }

  async function revocationReason(jti: string): Promise<string | null | undefined> {
    const row = await world.db
      .selectFrom('credential_revocations')
      .select('reason')
      .where('jti', '=', jti)
      .executeTakeFirst();
    return row === undefined ? undefined : row.reason;
  }

  async function workerTokenRows(): Promise<number> {
    const rows = await world.db
      .selectFrom('credentials')
      .select('jti')
      .where('participant_id', '=', agentId)
      .execute();
    return rows.length;
  }

  function create(): Promise<IssuedCredential> {
    return enrollment.issueWorkerToken({ agentId, mode: 'create', enrolledVia: enrollmentJti });
  }

  function renew(presentedJti: string): Promise<IssuedCredential> {
    return enrollment.issueWorkerToken({ agentId, mode: 'renew', presentedJti });
  }

  async function revokeEnrollment(reason: string): Promise<void> {
    await createBlocklist(world.db).add({
      jti: enrollmentJti,
      credentialExpiresAt: new Date(T0.getTime() + 90 * DAY_MS),
      reason,
    });
  }

  describe('issueWorkerToken', () => {
    it('create: issues a one-hour Worker token tied to the enrollment and points last_worker_jti at it', async () => {
      const token = await create();

      expect(token.participantId).toBe(agentId);
      expect(token.expiresAt).toEqual(new Date(T0.getTime() + HOUR_MS));
      const row = await world.db
        .selectFrom('credentials')
        .selectAll()
        .where('jti', '=', token.jti)
        .executeTakeFirstOrThrow();
      expect(row.enrolled_via).toBe(enrollmentJti);
      expect(row.participant_kind).toBe('worker');
      expect(row.scope).toBeNull();
      expect((await agentRow()).last_worker_jti).toBe(token.jti);

      const identity = await verifier.verify(`Bearer ${token.jwt}`);
      expect(identity.kind).toBe('worker');
      expect(identity.ownerId).toBe(world.adminHivekeeperId);
    });

    it('honours an explicit ttl', async () => {
      const token = await enrollment.issueWorkerToken({
        agentId,
        mode: 'create',
        enrolledVia: enrollmentJti,
        ttl: 5 * 60 * SECOND_MS,
      });
      expect(token.expiresAt).toEqual(new Date(T0.getTime() + 5 * 60 * SECOND_MS));
    });

    for (const mode of ['create', 'claim', 'revive'] as const) {
      it(`${mode}: supersedes every previous Worker token of the Agent inside the holder-proof window`, async () => {
        const stale = await create(); // expires T0 + 1h, then ages past the window
        clock = new Date(T0.getTime() + 10 * DAY_MS);
        const inWindow = await create(); // supersedes nothing still in the window
        clock = new Date(clock.getTime() + 3 * DAY_MS); // inWindow expired 3 days ago
        const current = await renew(inWindow.jti); // still valid, not superseded by renew

        await enrollment.issueWorkerToken({ agentId, mode, enrolledVia: enrollmentJti });

        expect(await revocationReason(inWindow.jti)).toBe('superseded');
        expect(await revocationReason(current.jti)).toBe('superseded');
        expect(await revocationReason(stale.jti)).toBeUndefined();
      });
    }

    it('renew: supersedes nothing, moves last_worker_jti and refreshes last_connected_at', async () => {
      const first = await create();
      clock = new Date(T0.getTime() + 30 * 60 * SECOND_MS);

      const second = await renew(first.jti);

      expect(await revocationReason(first.jti)).toBeUndefined();
      const agent = await agentRow();
      expect(agent.last_worker_jti).toBe(second.jti);
      expect(agent.last_connected_at).toBe(dateToIso(clock));
      const row = await world.db
        .selectFrom('credentials')
        .select('enrolled_via')
        .where('jti', '=', second.jti)
        .executeTakeFirstOrThrow();
      expect(row.enrolled_via).toBe(enrollmentJti);
    });

    it('renew: a proof that is no longer the last token loses the CAS and leaves nothing behind', async () => {
      const first = await create();
      await renew(first.jti);
      const rowsBefore = await workerTokenRows();

      await expectAuthError(renew(first.jti), 'CREDENTIAL_INAUTHENTIC', 'holder_proof_superseded');
      expect(await workerTokenRows()).toBe(rowsBefore);
    });

    it('renew: two concurrent renewals with the same proof, one wins and the other is superseded', async () => {
      const first = await create();
      const rowsBefore = await workerTokenRows();

      const results = await Promise.allSettled([renew(first.jti), renew(first.jti)]);

      const won = results.filter((r) => r.status === 'fulfilled');
      const lost = results.filter((r) => r.status === 'rejected');
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      const reason = (lost[0] as PromiseRejectedResult).reason as AuthError;
      expect(reason.code).toBe('CREDENTIAL_INAUTHENTIC');
      expect(reason.subCode).toBe('holder_proof_superseded');
      const winner = (won[0] as PromiseFulfilledResult<IssuedCredential>).value;
      expect((await agentRow()).last_worker_jti).toBe(winner.jti);
      expect(await workerTokenRows()).toBe(rowsBefore + 1);
    });

    it('renew: keeps working after the enrollment was rotated', async () => {
      const first = await create();
      await revokeEnrollment('rotation');
      const second = await renew(first.jti);
      expect((await agentRow()).last_worker_jti).toBe(second.jti);
    });

    it('renew: fails with CREDENTIAL_REVOKED once the enrollment is revoked', async () => {
      const first = await create();
      await revokeEnrollment('suspected leak');
      await expectAuthError(renew(first.jti), 'CREDENTIAL_REVOKED');
      expect((await agentRow()).last_worker_jti).toBe(first.jti);
    });

    for (const reason of ['rotation', 'suspected leak']) {
      it(`create: re-checks the enrollment blocklist and rolls back when it is listed (${reason})`, async () => {
        const first = await create();
        const rowsBefore = await workerTokenRows();
        await revokeEnrollment(reason);

        await expectAuthError(create(), 'CREDENTIAL_REVOKED');

        expect(await workerTokenRows()).toBe(rowsBefore);
        expect((await agentRow()).last_worker_jti).toBe(first.jti);
        expect(await revocationReason(first.jti)).toBeUndefined();
      });
    }

    it('joins the caller transaction: a rollback there discards the token', async () => {
      const rowsBefore = await workerTokenRows();
      await expect(
        world.db.transaction().execute(async (trx) => {
          await enrollment.issueWorkerToken(
            { agentId, mode: 'create', enrolledVia: enrollmentJti },
            trx,
          );
          throw new Error('caller aborts');
        }),
      ).rejects.toThrow('caller aborts');
      expect(await workerTokenRows()).toBe(rowsBefore);
      expect((await agentRow()).last_worker_jti).toBeNull();
    });

    it('requires enrolledVia outside renew and presentedJti in renew', async () => {
      await expect(enrollment.issueWorkerToken({ agentId, mode: 'claim' })).rejects.toThrow(
        /enrolledVia/,
      );
      await expect(enrollment.issueWorkerToken({ agentId, mode: 'renew' })).rejects.toThrow(
        /presentedJti/,
      );
    });
  });

  // ADR-026: the renewal primitive of register_session (issueWorkerToken in renew mode
  // plus the optional update of description and capabilities, in one transaction).
  describe('renewWorkerToken', () => {
    async function agentDetails() {
      return world.db
        .selectFrom('agents')
        .select(['description', 'capabilities', 'last_worker_jti'])
        .where('id', '=', agentId)
        .executeTakeFirstOrThrow();
    }

    it('renews with CAS and updates description and capabilities in the same transaction', async () => {
      const first = await create();

      const renewed = await enrollment.renewWorkerToken({
        agentId,
        presentedJti: first.jti,
        description: 'Reviews pull requests',
        capabilities: ['review'],
      });

      const agent = await agentDetails();
      expect(agent.last_worker_jti).toBe(renewed.jti);
      expect(agent.description).toBe('Reviews pull requests');
      expect(JSON.parse(agent.capabilities)).toEqual(['review']);
      expect(await revocationReason(first.jti)).toBeUndefined();
    });

    it('leaves description and capabilities alone when they are not given', async () => {
      await world.db
        .updateTable('agents')
        .set({ description: 'before', capabilities: '["a"]' })
        .where('id', '=', agentId)
        .execute();
      const first = await create();

      await enrollment.renewWorkerToken({ agentId, presentedJti: first.jti });

      const agent = await agentDetails();
      expect(agent.description).toBe('before');
      expect(JSON.parse(agent.capabilities)).toEqual(['a']);
    });

    it('rejects an invalid description with INVALID_INPUT{description_invalid} before issuing', async () => {
      const first = await create();
      const rowsBefore = await workerTokenRows();

      await expectAuthError(
        enrollment.renewWorkerToken({ agentId, presentedJti: first.jti, description: 'a\nb' }),
        'INVALID_INPUT',
        'description_invalid',
      );
      expect(await workerTokenRows()).toBe(rowsBefore);
    });

    it('rolls the description back when the proof lost the CAS', async () => {
      const first = await create();
      await renew(first.jti);

      await expectAuthError(
        enrollment.renewWorkerToken({ agentId, presentedJti: first.jti, description: 'stolen' }),
        'CREDENTIAL_INAUTHENTIC',
        'holder_proof_superseded',
      );
      expect((await agentDetails()).description).not.toBe('stolen');
    });

    it('of two concurrent renewals with the same proof exactly one wins', async () => {
      const first = await create();

      const results = await Promise.allSettled([
        enrollment.renewWorkerToken({ agentId, presentedJti: first.jti, description: 'one' }),
        enrollment.renewWorkerToken({ agentId, presentedJti: first.jti, description: 'two' }),
      ]);

      const won = results.filter((r) => r.status === 'fulfilled');
      expect(won).toHaveLength(1);
      const winner = (won[0] as PromiseFulfilledResult<IssuedCredential>).value;
      const agent = await agentDetails();
      expect(agent.last_worker_jti).toBe(winner.jti);
      // Only the winner's update survives.
      expect(agent.description).toBe(results[0]?.status === 'fulfilled' ? 'one' : 'two');
    });
  });

  describe('verifyRenewalBearer', () => {
    it('accepts the last token while it is still valid and marks the identity as a renewal', async () => {
      const token = await create();
      const identity = await verifier.verifyRenewalBearer(`Bearer ${token.jwt}`);
      expect(identity.participantId).toBe(agentId);
      expect(identity.kind).toBe('worker');
      expect(identity.snapshot.credentialJti).toBe(token.jti);
      expect(identity.snapshot.renewal).toBe(true);
    });

    it('accepts the last token expired six days ago, inside the 7-day window', async () => {
      const token = await create();
      clock = new Date(token.expiresAt.getTime() + 6 * DAY_MS);
      const identity = await verifier.verifyRenewalBearer(`Bearer ${token.jwt}`);
      expect(identity.snapshot.renewal).toBe(true);
    });

    it('rejects the last token expired beyond the window with holder_proof_expired', async () => {
      const token = await create();
      clock = new Date(token.expiresAt.getTime() + 7 * DAY_MS + 5 * SECOND_MS + SECOND_MS);
      await expectAuthError(
        verifier.verifyRenewalBearer(`Bearer ${token.jwt}`),
        'CREDENTIAL_INAUTHENTIC',
        'holder_proof_expired',
      );
    });

    it('with a zero window only accepts tokens that are still valid', async () => {
      const token = await create();
      clock = new Date(token.expiresAt.getTime() + 60 * SECOND_MS);
      await expectAuthError(
        buildVerifier(0).verifyRenewalBearer(`Bearer ${token.jwt}`),
        'CREDENTIAL_INAUTHENTIC',
        'holder_proof_expired',
      );
    });

    it('rejects a token that is not the last one issued with holder_proof_superseded', async () => {
      const first = await create();
      await renew(first.jti);
      await expectAuthError(
        verifier.verifyRenewalBearer(`Bearer ${first.jwt}`),
        'CREDENTIAL_INAUTHENTIC',
        'holder_proof_superseded',
      );
    });

    it('rejects a token superseded by a new registration with holder_proof_superseded', async () => {
      const first = await create();
      await enrollment.issueWorkerToken({ agentId, mode: 'claim', enrolledVia: enrollmentJti });
      await expectAuthError(
        verifier.verifyRenewalBearer(`Bearer ${first.jwt}`),
        'CREDENTIAL_INAUTHENTIC',
        'holder_proof_superseded',
      );
    });

    it('rejects a token revoked for any other reason with CREDENTIAL_REVOKED', async () => {
      const token = await create();
      await createBlocklist(world.db).add({
        jti: token.jti,
        credentialExpiresAt: token.expiresAt,
        reason: 'enrollment_revoked',
      });
      await expectAuthError(
        verifier.verifyRenewalBearer(`Bearer ${token.jwt}`),
        'CREDENTIAL_REVOKED',
      );
    });

    for (const state of ['suspended', 'retired'] as const) {
      it(`rejects the token of a ${state} Agent with PARTICIPANT_NOT_ACTIVE{${state}}`, async () => {
        const token = await create();
        await world.db
          .updateTable('agents')
          .set({ state, retired_at: state === 'retired' ? dateToIso(clock) : null })
          .where('id', '=', agentId)
          .execute();
        await expectAuthError(
          verifier.verifyRenewalBearer(`Bearer ${token.jwt}`),
          'PARTICIPANT_NOT_ACTIVE',
          state,
        );
      });
    }

    it('rejects the token of an Agent converted to manual with holder_proof_invalid', async () => {
      const token = await create();
      await world.db
        .updateTable('agents')
        .set({ origin: 'manual', enrolled_via: null })
        .where('id', '=', agentId)
        .execute();
      await expectAuthError(
        verifier.verifyRenewalBearer(`Bearer ${token.jwt}`),
        'CREDENTIAL_INAUTHENTIC',
        'holder_proof_invalid',
      );
    });

    it('rejects credentials that were not issued by register_session with holder_proof_invalid', async () => {
      const issuer = createIssuer({
        signingKey: world.signingKey,
        participantsRepo: createParticipantsReadRepo(world.db),
        hiveStableIdentifier: world.hiveId,
        defaultTtlMs: HOUR_MS,
        db: world.db,
        now: () => clock,
      });
      const fullAgent = await issuer.issueCredential({ participantId: agentId });
      const fullKeeper = await issuer.issueCredential({ participantId: world.adminHivekeeperId });
      const enrollmentJwt = (
        await enrollment.issueEnrollmentCredential(
          { ownerId: world.adminHivekeeperId },
          { kind: 'system' },
        )
      ).jwt;

      for (const jwt of [fullAgent.jwt, fullKeeper.jwt, enrollmentJwt]) {
        await expectAuthError(
          verifier.verifyRenewalBearer(`Bearer ${jwt}`),
          'CREDENTIAL_INAUTHENTIC',
          'holder_proof_invalid',
        );
      }
    });

    it('keeps the checks of verify for the header and the signature', async () => {
      await expectAuthError(verifier.verifyRenewalBearer(undefined), 'CREDENTIAL_MISSING');
      const token = await create();
      const [header, payload] = token.jwt.split('.');
      const forged = await new jose.SignJWT(
        JSON.parse(Buffer.from(payload as string, 'base64url').toString()) as jose.JWTPayload,
      )
        .setProtectedHeader(
          JSON.parse(
            Buffer.from(header as string, 'base64url').toString(),
          ) as jose.JWTHeaderParameters,
        )
        .sign((await jose.generateKeyPair('EdDSA')).privateKey);
      await expectAuthError(
        verifier.verifyRenewalBearer(`Bearer ${forged}`),
        'CREDENTIAL_INAUTHENTIC',
        'signature',
      );
    });

    it('accepts a proof only once: after a renewal the old token is superseded', async () => {
      const first = await create();
      const identity = await verifier.verifyRenewalBearer(`Bearer ${first.jwt}`);
      await renew(identity.snapshot.credentialJti);
      await expectAuthError(
        verifier.verifyRenewalBearer(`Bearer ${first.jwt}`),
        'CREDENTIAL_INAUTHENTIC',
        'holder_proof_superseded',
      );
    });
  });
});
