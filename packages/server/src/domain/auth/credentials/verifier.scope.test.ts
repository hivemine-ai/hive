// ADR-026: credentials that carry a `scope`, and the `retired` Agent state, in the verifier.

import * as jose from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';

import { isAuthError } from '../errors.js';
import type { AuthError, AuthErrorCode } from '../errors.js';
import { destroyWorld, seedWorld, type SeedWorld } from '../test-helpers.js';
import { createParticipantsReadRepo } from '#domain/auth/participants/repository.js';
import { dateToIso } from '#persistence/type-mappers.js';
import { createBlocklist } from './blocklist.js';
import { createEnrollment } from './enrollment.js';
import { createIssuer } from './issuer.js';
import { createVerifier } from './verifier.js';
import type { Verifier } from './verifier.js';

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

describe('verifier with scoped credentials and retired agents', () => {
  let world: SeedWorld;
  let verifier: Verifier;

  beforeEach(async () => {
    world = await seedWorld();
    verifier = createVerifier({
      signingKeys: new Map([[world.signingKey.kid, world.signingKey]]),
      blocklist: createBlocklist(world.db),
      participantsRepo: createParticipantsReadRepo(world.db),
      hiveStableIdentifier: world.hiveId,
    });
  });

  afterEach(async () => {
    await destroyWorld(world);
  });

  async function enrollmentFor(ownerId: string): Promise<string> {
    const enrollment = createEnrollment({
      signingKey: world.signingKey,
      participantsRepo: createParticipantsReadRepo(world.db),
      hiveStableIdentifier: world.hiveId,
      db: world.db,
      enrollmentTtlMs: 60_000,
      hiveMaxAgents: 10,
    });
    const issued = await enrollment.issueEnrollmentCredential({ ownerId }, { kind: 'system' });
    return issued.jwt;
  }

  async function fullCredentialFor(participantId: string): Promise<string> {
    const issuer = createIssuer({
      signingKey: world.signingKey,
      participantsRepo: createParticipantsReadRepo(world.db),
      hiveStableIdentifier: world.hiveId,
      defaultTtlMs: 60_000,
      db: world.db,
    });
    return (await issuer.issueCredential({ participantId })).jwt;
  }

  it('does not populate isAdmin for an enrollment credential of an admin owner', async () => {
    const identity = await verifier.verify(
      `Bearer ${await enrollmentFor(world.adminHivekeeperId)}`,
    );
    expect(identity.snapshot.scope).toBe('enroll');
    expect(identity.current).toEqual({ state: 'active' });
  });

  it('verifyAndRequireAdmin rejects an enrollment credential with scoped_credential', async () => {
    const jwt = await enrollmentFor(world.adminHivekeeperId);
    await expectAuthError(
      verifier.verifyAndRequireAdmin(`Bearer ${jwt}`),
      'INSUFFICIENT_PRIVILEGE',
      'scoped_credential',
    );
  });

  it('verifyAndRequireAdmin accepts a full admin credential and rejects a non-admin one', async () => {
    const admin = await verifier.verifyAndRequireAdmin(
      `Bearer ${await fullCredentialFor(world.adminHivekeeperId)}`,
    );
    expect(admin.current.isAdmin).toBe(true);
    await expectAuthError(
      verifier.verifyAndRequireAdmin(
        `Bearer ${await fullCredentialFor(world.nonAdminHivekeeperId)}`,
      ),
      'INSUFFICIENT_PRIVILEGE',
      'not_admin',
    );
  });

  it('rejects a correctly signed JWT whose scope is unknown as CREDENTIAL_INAUTHENTIC', async () => {
    const now = Math.floor(Date.now() / 1000);
    const jwt = await new jose.SignJWT({
      sub: world.adminHivekeeperId,
      iss: world.hiveId,
      aud: world.hiveId,
      iat: now,
      nbf: now,
      exp: now + 60,
      jti: uuidv7(),
      kind: 'hivekeeper',
      scope: 'admin',
    })
      .setProtectedHeader({ alg: 'EdDSA', kid: world.signingKey.kid, typ: 'JWT' })
      .sign(world.signingKey.privateKey);

    await expectAuthError(verifier.verify(`Bearer ${jwt}`), 'CREDENTIAL_INAUTHENTIC', 'malformed');
  });

  it('rejects the token of a retired Agent as PARTICIPANT_NOT_ACTIVE{retired}', async () => {
    const jwt = await fullCredentialFor(world.workerAgentId);
    await world.db
      .updateTable('agents')
      .set({
        state: 'retired',
        retired_at: dateToIso(new Date()),
        origin: 'enrollment',
        enrolled_via: uuidv7(),
      })
      .where('id', '=', world.workerAgentId)
      .execute();

    await expectAuthError(verifier.verify(`Bearer ${jwt}`), 'PARTICIPANT_NOT_ACTIVE', 'retired');
  });
});
