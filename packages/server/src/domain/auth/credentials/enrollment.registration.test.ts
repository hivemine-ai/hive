// ADR-026 registration primitives: createEnrolledAgent, claimEnrolledAgent and
// revokeWorkerTokens. Runs against SQLite by default; set HIVE_TEST_PG_URL to run the same
// suite against Postgres (CI `postgres` job), where the concurrency tests race real
// transactions.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';

import { isAuthError } from '../errors.js';
import type { AuthError, AuthErrorCode } from '../errors.js';
import { destroyWorld, seedWorld, type SeedWorld } from '../test-helpers.js';
import type { IdentityContext } from '../types.js';
import type { CellsRepoHook } from '#domain/auth/participants/cells-hook.js';
import { createParticipantsReadRepo } from '#domain/auth/participants/repository.js';
import { createEnrollmentRetention } from '#domain/auth/participants/retention.js';
import { createParticipantStateSignal } from '#domain/auth/participants/state-signal.js';
import type { ParticipantStateChange } from '#domain/auth/participants/state-signal.js';
import { dateToIso } from '#persistence/type-mappers.js';
import { createBlocklist } from './blocklist.js';
import { createEnrollment } from './enrollment.js';
import type { Enrollment, IssueEnrollmentCredentialInput } from './enrollment.js';
import { createVerifier } from './verifier.js';
import type { Verifier } from './verifier.js';

const PG_URL = process.env['HIVE_TEST_PG_URL'];
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// Second-aligned and current, because `verify` reads the real clock.
const T0 = new Date(Math.floor(Date.now() / 1000) * 1000);

async function expectAuthError(
  promise: Promise<unknown>,
  code: AuthErrorCode,
  subCode?: string,
): Promise<AuthError> {
  try {
    await promise;
  } catch (err) {
    expect(isAuthError(err)).toBe(true);
    const e = err as AuthError;
    expect(e.code).toBe(code);
    if (subCode !== undefined) expect(e.subCode).toBe(subCode);
    return e;
  }
  return expect.fail(`expected AuthError(${code})`);
}

// The snapshot of a full (unscoped) credential with the same jti.
function fullSnapshot(identity: IdentityContext): IdentityContext['snapshot'] {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- dropped on purpose
  const { scope, ...rest } = identity.snapshot;
  return rest;
}

/**
 * Postgres only: retires the Agent in a transaction that holds the row uncommitted while
 * `during` starts, then commits. `during` reads the Agent as active and its write waits.
 */
async function retireWhile<T>(
  db: SeedWorld['db'],
  agentId: string,
  at: Date,
  during: () => Promise<T>,
): Promise<PromiseSettledResult<T>> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const rowLocked = new Promise<void>((resolve) => (locked = resolve));
  const retire = db.transaction().execute(async (trx) => {
    await trx
      .updateTable('agents')
      .set({ state: 'retired', retired_at: dateToIso(at) })
      .where('id', '=', agentId)
      .execute();
    locked();
    await gate;
  });
  await rowLocked;
  const settled = Promise.allSettled([during()]);
  await new Promise((resolve) => setTimeout(resolve, 300));
  release();
  await retire;
  return (await settled)[0];
}

describe(`registration primitives (${PG_URL ? 'postgres' : 'sqlite'})`, () => {
  let world: SeedWorld;
  let clock: Date;
  let enrollment: Enrollment;
  let verifier: Verifier;
  let createdCells: string[];
  let stateChanges: ParticipantStateChange[];

  beforeEach(async () => {
    world = await seedWorld({ pgUrl: PG_URL });
    clock = T0;
    createdCells = [];
    stateChanges = [];
    const stateSignal = createParticipantStateSignal();
    stateSignal.onParticipantStateChanged((change) => stateChanges.push(change));
    const cellsHook: CellsRepoHook = {
      createCell: (_executor, input) => {
        createdCells.push(input.ownerId);
        return Promise.resolve();
      },
      closeCell: () => Promise.resolve(),
      closeCellsByOwner: () => Promise.resolve(),
    };
    const participantsRepo = createParticipantsReadRepo(world.db);
    enrollment = createEnrollment({
      signingKey: world.signingKey,
      participantsRepo,
      hiveStableIdentifier: world.hiveId,
      db: world.db,
      dialect: PG_URL ? 'postgres' : 'sqlite',
      now: () => clock,
      enrollmentTtlMs: 90 * DAY_MS,
      hiveMaxAgents: 3,
      workerTokenTtlMs: HOUR_MS,
      cellsHook,
      stateSignal,
    });
    verifier = createVerifier({
      signingKeys: new Map([[world.signingKey.kid, world.signingKey]]),
      blocklist: createBlocklist(world.db),
      participantsRepo,
      hiveStableIdentifier: world.hiveId,
    });
  });

  afterEach(async () => {
    await destroyWorld(world);
  });

  async function enrollmentIdentity(
    claims: Omit<IssueEnrollmentCredentialInput, 'ownerId'> = {},
    ownerId: string = world.nonAdminHivekeeperId,
  ): Promise<IdentityContext> {
    const issued = await enrollment.issueEnrollmentCredential(
      { ownerId, ...claims },
      { kind: 'system' },
    );
    return verifier.verify(`Bearer ${issued.jwt}`);
  }

  function create(identity: IdentityContext, name: string, description = 'builds the docs') {
    return enrollment.createEnrolledAgent(
      {
        ownerId: identity.participantId,
        name,
        description,
        capabilities: ['docs'],
        enrolledVia: identity.snapshot.credentialJti,
      },
      identity,
    );
  }

  async function countActive(enrolledVia: string): Promise<number> {
    const rows = await world.db
      .selectFrom('agents')
      .select('id')
      .where('enrolled_via', '=', enrolledVia)
      .where('state', '=', 'active')
      .execute();
    return rows.length;
  }

  async function revocationReason(jti: string): Promise<string | null | undefined> {
    const row = await world.db
      .selectFrom('credential_revocations')
      .select('reason')
      .where('jti', '=', jti)
      .executeTakeFirst();
    return row === undefined ? undefined : row.reason;
  }

  describe('createEnrolledAgent', () => {
    it('creates an enrollment Worker with its Cell and a Worker token in one transaction', async () => {
      const identity = await enrollmentIdentity();
      const { agent, token } = await create(identity, 'docs-bot');

      expect(agent).toMatchObject({
        ownerId: world.nonAdminHivekeeperId,
        name: 'docs-bot',
        type: 'worker',
        state: 'active',
        origin: 'enrollment',
        enrolledVia: identity.snapshot.credentialJti,
        description: 'builds the docs',
        capabilities: ['docs'],
        lastConnectedAt: clock,
        lastWorkerJti: token.jti,
      });
      expect(createdCells).toEqual([agent.id]);
      const workerIdentity = await verifier.verify(`Bearer ${token.jwt}`);
      expect(workerIdentity.participantId).toBe(agent.id);
    });

    it('rejects a name outside the ADR-015 syntax with name_malformed', async () => {
      const identity = await enrollmentIdentity();
      await expectAuthError(create(identity, 'Docs_Bot'), 'INVALID_INPUT', 'name_malformed');
    });

    it('rejects a name that does not start with the name_prefix claim', async () => {
      const identity = await enrollmentIdentity({ namePrefix: 'ci-' });
      await create(identity, 'ci-docs');
      await expectAuthError(create(identity, 'docs'), 'INVALID_INPUT', 'name_prefix_mismatch');
    });

    it('rejects an empty, too long, multi-line or control-character description', async () => {
      const identity = await enrollmentIdentity();
      for (const description of ['', ' ', 'd'.repeat(281), 'line one\nline two', 'bell\u0007']) {
        await expectAuthError(
          create(identity, `bot-${uuidv7().slice(-6)}`, description),
          'INVALID_INPUT',
          'description_invalid',
        );
      }
      await create(identity, 'bot-max', 'd'.repeat(280));
    });

    it('rejects an identity that is not an enrollment credential of that owner', async () => {
      const identity = await enrollmentIdentity();
      const full: IdentityContext = {
        ...identity,
        snapshot: fullSnapshot(identity),
      };
      await expectAuthError(
        create(full, 'docs-bot'),
        'INSUFFICIENT_PRIVILEGE',
        'not_enrollment_owner',
      );
      await expectAuthError(
        enrollment.createEnrolledAgent(
          {
            ownerId: world.adminHivekeeperId,
            name: 'docs-bot',
            description: 'x',
            enrolledVia: identity.snapshot.credentialJti,
          },
          identity,
        ),
        'INSUFFICIENT_PRIVILEGE',
        'not_enrollment_owner',
      );
    });

    it('counts only active Agents of the enrollment against the max_agents claim', async () => {
      const identity = await enrollmentIdentity({ maxAgents: 2 });
      const { agent: first } = await create(identity, 'bot-a');
      await create(identity, 'bot-b');
      const err = await expectAuthError(create(identity, 'bot-c'), 'ENROLLMENT_QUOTA_EXCEEDED');
      expect(err.limit).toBe(2);

      await world.db
        .updateTable('agents')
        .set({ state: 'retired', retired_at: dateToIso(clock) })
        .where('id', '=', first.id)
        .execute();
      await create(identity, 'bot-c');
    });

    it('applies HIVE_ENROLLMENT_MAX_AGENTS when the credential has no max_agents claim', async () => {
      const identity = await enrollmentIdentity();
      for (const name of ['bot-a', 'bot-b', 'bot-c']) await create(identity, name);
      const err = await expectAuthError(create(identity, 'bot-d'), 'ENROLLMENT_QUOTA_EXCEEDED');
      expect(err.limit).toBe(3);
    });

    it('maps a name already held by a non-revoked Agent of the owner to NAME_IN_USE', async () => {
      const identity = await enrollmentIdentity();
      await create(identity, 'docs-bot');
      await expectAuthError(create(identity, 'docs-bot'), 'NAME_IN_USE');
    });

    it('two concurrent creates with the same name: one creates, the other gets NAME_IN_USE', async () => {
      const identity = await enrollmentIdentity();
      const results = await Promise.allSettled([
        create(identity, 'docs-bot'),
        create(identity, 'docs-bot'),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect((lost.reason as AuthError).code).toBe('NAME_IN_USE');
      expect(await countActive(identity.snapshot.credentialJti)).toBe(1);
    });

    it('two concurrent creates with one quota slot left never exceed max_agents', async () => {
      const identity = await enrollmentIdentity({ maxAgents: 2 });
      await create(identity, 'bot-a');
      const results = await Promise.allSettled([
        create(identity, 'bot-b'),
        create(identity, 'bot-c'),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect((lost.reason as AuthError).code).toBe('ENROLLMENT_QUOTA_EXCEEDED');
      expect(await countActive(identity.snapshot.credentialJti)).toBe(2);
    });
  });

  describe('claimEnrolledAgent', () => {
    it('reassigns the Agent to the claiming enrollment, keeps its id and supersedes its tokens', async () => {
      const first = await enrollmentIdentity();
      const { agent, token: oldToken } = await create(first, 'docs-bot');
      const second = await enrollmentIdentity();
      clock = new Date(T0.getTime() + HOUR_MS);

      const { agent: claimed, token } = await enrollment.claimEnrolledAgent(
        {
          agentId: agent.id,
          description: 'now builds the site',
          capabilities: ['site'],
          enrolledVia: second.snapshot.credentialJti,
        },
        second,
      );

      expect(claimed).toMatchObject({
        id: agent.id,
        state: 'active',
        origin: 'enrollment',
        enrolledVia: second.snapshot.credentialJti,
        description: 'now builds the site',
        capabilities: ['site'],
        lastConnectedAt: clock,
        lastWorkerJti: token.jti,
      });
      expect(await revocationReason(oldToken.jti)).toBe('superseded');
      expect(createdCells).toEqual([agent.id]);
    });

    it('refuses a manual or suspended Agent with INVALID_STATE_TRANSITION', async () => {
      const identity = await enrollmentIdentity({}, world.adminHivekeeperId);
      const claim = (agentId: string) =>
        enrollment.claimEnrolledAgent(
          { agentId, description: 'x', enrolledVia: identity.snapshot.credentialJti },
          identity,
        );
      await expectAuthError(claim(world.workerAgentId), 'INVALID_STATE_TRANSITION');

      const { agent } = await create(identity, 'docs-bot');
      await world.db
        .updateTable('agents')
        .set({ state: 'suspended' })
        .where('id', '=', agent.id)
        .execute();
      await expectAuthError(claim(agent.id), 'INVALID_STATE_TRANSITION');
    });

    // PRY-094: retirement vs claim. SQLite serializes writers, so only Postgres races.
    it.runIf(PG_URL)(
      'loses to a retirement that commits while it waits: no token, the Agent stays retired',
      async () => {
        const identity = await enrollmentIdentity();
        const { agent } = await create(identity, 'docs-bot');

        const outcome = await retireWhile(world.db, agent.id, clock, () =>
          enrollment.claimEnrolledAgent(
            { agentId: agent.id, description: 'x', enrolledVia: identity.snapshot.credentialJti },
            identity,
          ),
        );

        expect(outcome.status).toBe('rejected');
        const err = (outcome as PromiseRejectedResult).reason as AuthError;
        expect([err.code, err.subCode]).toEqual([
          'INVALID_STATE_TRANSITION',
          'claim_requires_active_enrollment_agent',
        ]);
        const row = await world.db
          .selectFrom('agents')
          .select(['state', 'last_worker_jti'])
          .where('id', '=', agent.id)
          .executeTakeFirstOrThrow();
        expect(row.state).toBe('retired');
        expect(await countActive(identity.snapshot.credentialJti)).toBe(0);
      },
    );

    it('refuses an Agent of another owner', async () => {
      const mine = await enrollmentIdentity();
      const { agent } = await create(mine, 'docs-bot');
      const other = await enrollmentIdentity({}, world.adminHivekeeperId);
      await expectAuthError(
        enrollment.claimEnrolledAgent(
          { agentId: agent.id, description: 'x', enrolledVia: other.snapshot.credentialJti },
          other,
        ),
        'INSUFFICIENT_PRIVILEGE',
        'not_enrollment_owner',
      );
    });
  });

  describe('reviveRetiredAgent (PRY-094)', () => {
    async function retire(agentId: string, at: Date = clock): Promise<void> {
      await world.db
        .updateTable('agents')
        .set({ state: 'retired', retired_at: dateToIso(at) })
        .where('id', '=', agentId)
        .execute();
    }

    function revive(identity: IdentityContext, agentId: string, description = 'is back') {
      return enrollment.reviveRetiredAgent(
        {
          agentId,
          description,
          capabilities: ['back'],
          enrolledVia: identity.snapshot.credentialJti,
        },
        identity,
      );
    }

    it('reactivates the same Agent and Cell, supersedes the old tokens and signals active', async () => {
      const first = await enrollmentIdentity();
      const { agent, token: oldToken } = await create(first, 'docs-bot');
      await retire(agent.id);
      const second = await enrollmentIdentity();

      const { agent: revived, token } = await revive(second, agent.id);

      expect(revived).toMatchObject({
        id: agent.id,
        state: 'active',
        retiredAt: null,
        origin: 'enrollment',
        enrolledVia: second.snapshot.credentialJti,
        description: 'is back',
        capabilities: ['back'],
        lastConnectedAt: clock,
        lastWorkerJti: token.jti,
      });
      expect(createdCells).toEqual([agent.id]);
      expect(await revocationReason(oldToken.jti)).toBe('superseded');
      const identity = await verifier.verify(`Bearer ${token.jwt}`);
      expect(identity.participantId).toBe(agent.id);
      await expectAuthError(verifier.verify(`Bearer ${oldToken.jwt}`), 'CREDENTIAL_REVOKED');
      expect(stateChanges).toEqual([{ participantId: agent.id, newState: 'active' }]);
    });

    it('checks the quota like a create: a full enrollment leaves the Agent retired', async () => {
      const identity = await enrollmentIdentity({ maxAgents: 1 });
      const { agent } = await create(identity, 'bot-a');
      await retire(agent.id);
      await create(identity, 'bot-b');

      const err = await expectAuthError(revive(identity, agent.id), 'ENROLLMENT_QUOTA_EXCEEDED');

      expect(err.limit).toBe(1);
      const row = await world.db
        .selectFrom('agents')
        .select('state')
        .where('id', '=', agent.id)
        .executeTakeFirstOrThrow();
      expect(row.state).toBe('retired');
      expect(stateChanges).toEqual([]);
    });

    it('refuses an Agent that is not retired, or not of enrollment origin', async () => {
      const identity = await enrollmentIdentity({}, world.adminHivekeeperId);
      const { agent } = await create(identity, 'docs-bot');
      await expectAuthError(
        revive(identity, agent.id),
        'INVALID_STATE_TRANSITION',
        'revive_requires_retired_enrollment_agent',
      );
      await expectAuthError(
        revive(identity, world.workerAgentId),
        'INVALID_STATE_TRANSITION',
        'revive_requires_retired_enrollment_agent',
      );
    });

    it('refuses an Agent of another owner', async () => {
      const mine = await enrollmentIdentity();
      const { agent } = await create(mine, 'docs-bot');
      await retire(agent.id);
      const other = await enrollmentIdentity({}, world.adminHivekeeperId);
      await expectAuthError(
        revive(other, agent.id),
        'INSUFFICIENT_PRIVILEGE',
        'not_enrollment_owner',
      );
    });

    // Revival vs end of grace on the same retired Agent: exactly one wins.
    it('races the grace pass of the retention job: exactly one winner', async () => {
      const identity = await enrollmentIdentity();
      const { agent } = await create(identity, 'docs-bot');
      await retire(agent.id, new Date(T0.getTime() - 61 * DAY_MS));
      const retention = createEnrollmentRetention({
        db: world.db,
        retentionDays: 0,
        graceDays: 60,
      });

      const [revival, run] = await Promise.allSettled([
        revive(identity, agent.id),
        retention.runEnrollmentRetention(clock, { kind: 'system' }, { isHolderLive: () => false }),
      ]);

      expect(run.status).toBe('fulfilled');
      const { revokedAgentIds } = (run as PromiseFulfilledResult<{ revokedAgentIds: string[] }>)
        .value;
      const row = await world.db
        .selectFrom('agents')
        .select('state')
        .where('id', '=', agent.id)
        .executeTakeFirstOrThrow();
      if (revival.status === 'fulfilled') {
        expect(revokedAgentIds).toEqual([]);
        expect(row.state).toBe('active');
      } else {
        const err = revival.reason as AuthError;
        expect([err.code, err.subCode]).toEqual([
          'INVALID_STATE_TRANSITION',
          'revive_requires_retired_enrollment_agent',
        ]);
        expect(revokedAgentIds).toEqual([agent.id]);
        expect(row.state).toBe('revoked');
      }
    });

    // Postgres: the grace revocation holds the row uncommitted; the revival read it as
    // retired and its conditional UPDATE re-evaluates after the commit.
    it.runIf(PG_URL)(
      'loses to a grace revocation that commits while it waits: no token issued',
      async () => {
        const identity = await enrollmentIdentity();
        const { agent } = await create(identity, 'docs-bot');
        await retire(agent.id);
        const tokensBefore = await world.db
          .selectFrom('credentials')
          .select('jti')
          .where('participant_id', '=', agent.id)
          .execute();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let locked!: () => void;
        const rowLocked = new Promise<void>((resolve) => (locked = resolve));
        const grace = world.db.transaction().execute(async (trx) => {
          await trx
            .updateTable('agents')
            .set({ state: 'revoked', revoked_at: dateToIso(clock), retired_at: null })
            .where('id', '=', agent.id)
            .execute();
          locked();
          await gate;
        });
        await rowLocked;
        const revival = Promise.allSettled([revive(identity, agent.id)]);
        await new Promise((resolve) => setTimeout(resolve, 300));
        release();
        await grace;
        const [outcome] = await revival;

        expect(outcome?.status).toBe('rejected');
        const err = (outcome as PromiseRejectedResult).reason as AuthError;
        expect([err.code, err.subCode]).toEqual([
          'INVALID_STATE_TRANSITION',
          'revive_requires_retired_enrollment_agent',
        ]);
        const tokensAfter = await world.db
          .selectFrom('credentials')
          .select('jti')
          .where('participant_id', '=', agent.id)
          .execute();
        expect(tokensAfter).toHaveLength(tokensBefore.length);
      },
    );
  });

  describe('revokeWorkerTokens', () => {
    it('blocklists every Worker token of the Agent in the window and clears last_worker_jti', async () => {
      const identity = await enrollmentIdentity();
      const { agent, token: first } = await create(identity, 'docs-bot');
      const second = await enrollment.issueWorkerToken({
        agentId: agent.id,
        mode: 'renew',
        presentedJti: first.jti,
      });

      const result = await enrollment.revokeWorkerTokens(
        { agentId: agent.id, revokedBy: world.nonAdminHivekeeperId, reason: 'agent_release' },
        { kind: 'system' },
      );

      expect(new Set(result.revokedTokenJtis)).toEqual(new Set([first.jti, second.jti]));
      expect(await revocationReason(first.jti)).toBe('agent_release');
      const row = await world.db
        .selectFrom('agents')
        .select(['last_worker_jti', 'state'])
        .where('id', '=', agent.id)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ last_worker_jti: null, state: 'active' });
      await expect(verifier.verify(`Bearer ${second.jwt}`)).rejects.toMatchObject({
        code: 'CREDENTIAL_REVOKED',
      });
    });

    // PRY-094: hivectl agent release racing a renewal of the holder. Whichever commits
    // first, no token of the holder survives: the renewal loses its CAS, or its new token
    // is in the blocklist.
    it('races a renewal: the holder ends with no usable token', async () => {
      const identity = await enrollmentIdentity();
      const { agent, token: first } = await create(identity, 'docs-bot');

      const [renewal, released] = await Promise.allSettled([
        enrollment.renewWorkerToken({ agentId: agent.id, presentedJti: first.jti }),
        enrollment.revokeWorkerTokens(
          { agentId: agent.id, revokedBy: world.nonAdminHivekeeperId, reason: 'agent_release' },
          { kind: 'system' },
        ),
      ]);

      expect(released.status).toBe('fulfilled');
      expect(await revocationReason(first.jti)).toBe('agent_release');
      if (renewal.status === 'fulfilled') {
        expect(await revocationReason(renewal.value.jti)).toBe('agent_release');
      } else {
        const err = renewal.reason as AuthError;
        expect([err.code, err.subCode]).toEqual([
          'CREDENTIAL_INAUTHENTIC',
          'holder_proof_superseded',
        ]);
      }
      const row = await world.db
        .selectFrom('agents')
        .select('last_worker_jti')
        .where('id', '=', agent.id)
        .executeTakeFirstOrThrow();
      expect(row.last_worker_jti).toBeNull();
    });

    // Postgres: a renewal holds the Agent row with its new token uncommitted while the
    // release starts; the release must still blocklist that token once it commits.
    it.runIf(PG_URL)(
      'blocklists a token whose renewal commits while the release waits',
      async () => {
        const identity = await enrollmentIdentity();
        const { agent, token: first } = await create(identity, 'docs-bot');
        let renewedJti!: string;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let locked!: () => void;
        const rowLocked = new Promise<void>((resolve) => (locked = resolve));
        const renewal = world.db.transaction().execute(async (trx) => {
          const token = await enrollment.issueWorkerToken(
            { agentId: agent.id, mode: 'renew', presentedJti: first.jti },
            trx,
          );
          renewedJti = token.jti;
          locked();
          await gate;
        });
        await rowLocked;

        const releasing = enrollment.revokeWorkerTokens(
          { agentId: agent.id, revokedBy: world.nonAdminHivekeeperId, reason: 'agent_release' },
          { kind: 'system' },
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
        release();
        await renewal;
        const result = await releasing;

        expect(result.revokedTokenJtis).toContain(renewedJti);
        expect(await revocationReason(renewedJti)).toBe('agent_release');
      },
    );

    it('is idempotent: a second call returns no tokens', async () => {
      const identity = await enrollmentIdentity();
      const { agent } = await create(identity, 'docs-bot');
      const input = {
        agentId: agent.id,
        revokedBy: world.nonAdminHivekeeperId,
        reason: 'agent_release',
      };
      await enrollment.revokeWorkerTokens(input, { kind: 'system' });
      expect(await enrollment.revokeWorkerTokens(input, { kind: 'system' })).toEqual({
        revokedTokenJtis: [],
      });
    });

    it('leaves tokens expired beyond the holder-proof window alone', async () => {
      const identity = await enrollmentIdentity();
      const { agent, token } = await create(identity, 'docs-bot');
      clock = new Date(T0.getTime() + 8 * DAY_MS);
      const result = await enrollment.revokeWorkerTokens(
        { agentId: agent.id, revokedBy: world.nonAdminHivekeeperId, reason: 'agent_release' },
        { kind: 'system' },
      );
      expect(result.revokedTokenJtis).toEqual([]);
      expect(await revocationReason(token.jti)).toBeUndefined();
    });

    it('lets the owner revoke but not another non-admin Hivekeeper', async () => {
      const identity = await enrollmentIdentity();
      const { agent } = await create(identity, 'docs-bot');
      const callerFor = (participantId: string) => ({
        kind: 'authenticated' as const,
        identity: {
          ...identity,
          participantId,
          snapshot: fullSnapshot(identity),
          current: { state: 'active' as const, isAdmin: false },
        },
      });
      const input = {
        agentId: agent.id,
        revokedBy: world.nonAdminHivekeeperId,
        reason: 'agent_release',
      };
      await expectAuthError(
        enrollment.revokeWorkerTokens(input, callerFor(uuidv7())),
        'INSUFFICIENT_PRIVILEGE',
        'not_admin',
      );
      const result = await enrollment.revokeWorkerTokens(
        input,
        callerFor(world.nonAdminHivekeeperId),
      );
      expect(result.revokedTokenJtis).toHaveLength(1);
    });
  });
});
