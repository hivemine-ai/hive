import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';

import type { CallerContext } from '../caller-context.js';
import { isAuthError } from '../errors.js';
import type { AuthError, AuthErrorCode } from '../errors.js';
import { destroyWorld, markHivekeeperRevoked, seedWorld, type SeedWorld } from '../test-helpers.js';
import type { IdentityContext } from '../types.js';
import { createParticipantsReadRepo } from '#domain/auth/participants/repository.js';
import { createBlocklist } from './blocklist.js';
import { createEnrollment } from './enrollment.js';
import type { Enrollment } from './enrollment.js';
import { createVerifier } from './verifier.js';
import type { Verifier } from './verifier.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = new Date('2026-11-05T12:00:00.000Z');

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

function hivekeeperCaller(
  world: SeedWorld,
  participantId: string,
  overrides: { isAdmin?: boolean; scope?: 'enroll' } = {},
): CallerContext {
  const identity: IdentityContext = {
    participantId,
    kind: 'hivekeeper',
    hiveId: world.hiveId,
    hiveName: 'test-hive',
    colonyId: world.colonyId,
    snapshot: {
      issuedAt: T0,
      credentialJti: uuidv7(),
      credentialKid: world.signingKey.kid,
      ...(overrides.scope !== undefined ? { scope: overrides.scope } : {}),
    },
    current: {
      state: 'active',
      ...(overrides.isAdmin !== undefined ? { isAdmin: overrides.isAdmin } : {}),
    },
  };
  return { kind: 'authenticated', identity };
}

describe('issueEnrollmentCredential', () => {
  let world: SeedWorld;
  let enrollment: Enrollment;
  let verifier: Verifier;

  beforeEach(async () => {
    world = await seedWorld();
    const participantsRepo = createParticipantsReadRepo(world.db);
    enrollment = createEnrollment({
      signingKey: world.signingKey,
      participantsRepo,
      hiveStableIdentifier: world.hiveId,
      db: world.db,
      now: () => T0,
      enrollmentTtlMs: 90 * DAY_MS,
      hiveMaxAgents: 10,
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

  const self = (w: SeedWorld) => hivekeeperCaller(w, w.nonAdminHivekeeperId, { isAdmin: false });

  it('issues a credential for the caller itself that verifies with scope enroll and its claims', async () => {
    const issued = await enrollment.issueEnrollmentCredential(
      { ownerId: world.nonAdminHivekeeperId, namePrefix: 'ci-', maxAgents: 3 },
      self(world),
    );

    expect(issued.participantId).toBe(world.nonAdminHivekeeperId);
    expect(issued.expiresAt).toEqual(new Date(T0.getTime() + 90 * DAY_MS));

    const identity = await verifier.verify(`Bearer ${issued.jwt}`);
    expect(identity.kind).toBe('hivekeeper');
    expect(identity.participantId).toBe(world.nonAdminHivekeeperId);
    expect(identity.snapshot.scope).toBe('enroll');
    expect(identity.snapshot.namePrefix).toBe('ci-');
    expect(identity.snapshot.maxAgents).toBe(3);
  });

  it('persists the credential row with scope enroll and the claims in the snapshot', async () => {
    const issued = await enrollment.issueEnrollmentCredential(
      { ownerId: world.nonAdminHivekeeperId, namePrefix: 'ci-', maxAgents: 3 },
      self(world),
    );
    const row = await world.db
      .selectFrom('credentials')
      .selectAll()
      .where('jti', '=', issued.jti)
      .executeTakeFirstOrThrow();
    expect(row.scope).toBe('enroll');
    expect(row.enrolled_via).toBeNull();
    expect(row.participant_kind).toBe('hivekeeper');
    expect(row.issued_by).toBe(world.nonAdminHivekeeperId);
    const snapshot = JSON.parse(row.snapshot) as Record<string, unknown>;
    expect(snapshot).toMatchObject({ scope: 'enroll', name_prefix: 'ci-', max_agents: 3 });
    expect(snapshot).not.toHaveProperty('owner_id');
  });

  it('omits name_prefix and max_agents when they are not given', async () => {
    const issued = await enrollment.issueEnrollmentCredential(
      { ownerId: world.nonAdminHivekeeperId },
      self(world),
    );
    const identity = await verifier.verify(`Bearer ${issued.jwt}`);
    expect(identity.snapshot.scope).toBe('enroll');
    expect(identity.snapshot).not.toHaveProperty('namePrefix');
    expect(identity.snapshot).not.toHaveProperty('maxAgents');
  });

  it('honours an explicit ttl over the 90-day default', async () => {
    const issued = await enrollment.issueEnrollmentCredential(
      { ownerId: world.nonAdminHivekeeperId, ttl: 7 * DAY_MS },
      self(world),
    );
    expect(issued.expiresAt).toEqual(new Date(T0.getTime() + 7 * DAY_MS));
  });

  it('rejects a non-admin Hivekeeper issuing for another owner', async () => {
    await expectAuthError(
      enrollment.issueEnrollmentCredential({ ownerId: world.adminHivekeeperId }, self(world)),
      'INSUFFICIENT_PRIVILEGE',
      'not_admin',
    );
  });

  it('lets an admin issue for another owner', async () => {
    const issued = await enrollment.issueEnrollmentCredential(
      { ownerId: world.nonAdminHivekeeperId },
      hivekeeperCaller(world, world.adminHivekeeperId, { isAdmin: true }),
    );
    expect(issued.participantId).toBe(world.nonAdminHivekeeperId);
  });

  it('lets the system caller (hivectl operator) issue for any owner', async () => {
    const issued = await enrollment.issueEnrollmentCredential(
      { ownerId: world.nonAdminHivekeeperId },
      { kind: 'system' },
    );
    const row = await world.db
      .selectFrom('credentials')
      .select('issued_by')
      .where('jti', '=', issued.jti)
      .executeTakeFirstOrThrow();
    expect(row.issued_by).toBeNull();
  });

  it('rejects a caller that authenticated with a scoped credential, even for itself', async () => {
    await expectAuthError(
      enrollment.issueEnrollmentCredential(
        { ownerId: world.nonAdminHivekeeperId },
        hivekeeperCaller(world, world.nonAdminHivekeeperId, { scope: 'enroll' }),
      ),
      'INSUFFICIENT_PRIVILEGE',
      'scoped_credential',
    );
  });

  it('accepts max_agents equal to HIVE_ENROLLMENT_MAX_AGENTS and rejects one above it', async () => {
    await enrollment.issueEnrollmentCredential(
      { ownerId: world.nonAdminHivekeeperId, maxAgents: 10 },
      self(world),
    );
    await expectAuthError(
      enrollment.issueEnrollmentCredential(
        { ownerId: world.nonAdminHivekeeperId, maxAgents: 11 },
        self(world),
      ),
      'INVALID_INPUT',
      'max_agents_exceeds_hive_limit',
    );
  });

  it('rejects a max_agents that is not a positive integer', async () => {
    for (const maxAgents of [0, -1, 1.5]) {
      await expectAuthError(
        enrollment.issueEnrollmentCredential(
          { ownerId: world.nonAdminHivekeeperId, maxAgents },
          self(world),
        ),
        'INVALID_INPUT',
        'max_agents_invalid',
      );
    }
  });

  it('accepts a name_prefix with the agent name syntax of ADR-015 and rejects others', async () => {
    for (const namePrefix of ['ci', 'ci-', 'w2-build']) {
      await enrollment.issueEnrollmentCredential(
        { ownerId: world.nonAdminHivekeeperId, namePrefix },
        self(world),
      );
    }
    for (const namePrefix of ['', 'CI-', '2ci', 'ci_', 'ci.x', 'ci x']) {
      await expectAuthError(
        enrollment.issueEnrollmentCredential(
          { ownerId: world.nonAdminHivekeeperId, namePrefix },
          self(world),
        ),
        'INVALID_INPUT',
        'name_prefix_invalid',
      );
    }
  });

  it('rejects an unknown owner or an owner that is an Agent', async () => {
    for (const ownerId of [uuidv7(), world.workerAgentId]) {
      await expectAuthError(
        enrollment.issueEnrollmentCredential({ ownerId }, { kind: 'system' }),
        'PARTICIPANT_NOT_FOUND_FOR_ISSUE',
      );
    }
  });

  it('rejects a revoked owner', async () => {
    await markHivekeeperRevoked(world, world.nonAdminHivekeeperId);
    await expectAuthError(
      enrollment.issueEnrollmentCredential(
        { ownerId: world.nonAdminHivekeeperId },
        { kind: 'system' },
      ),
      'PARTICIPANT_NOT_ACTIVE',
      'revoked',
    );
  });
});
