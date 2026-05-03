import * as jose from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';

import {
  destroyWorld,
  markAgentRevoked,
  markHivekeeperRevoked,
  seedWorld,
  type SeedWorld,
} from '../test-helpers.js';
import { isAuthError } from '../errors.js';
import type { AuthError, AuthErrorCode } from '../errors.js';
import { generateKeypair } from '#domain/auth/keys/keypair-store.js';
import { createParticipantsReadRepo } from '#domain/auth/participants/repository.js';
import { loadBlocklist } from './blocklist.js';
import { createIssuer } from './issuer.js';
import { createVerifier } from './verifier.js';

interface SignTokenOptions {
  iat?: number;
  nbf?: number;
  exp?: number;
  iss?: string;
  aud?: string;
  jti?: string;
  sub?: string;
  kid?: string;
  alg?: 'EdDSA';
}

async function signWith(
  world: SeedWorld,
  participantId: string,
  opts: SignTokenOptions = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: jose.JWTPayload = {
    sub: opts.sub ?? participantId,
    iss: opts.iss ?? world.hiveId,
    aud: opts.aud ?? world.hiveId,
    iat: opts.iat ?? now,
    nbf: opts.nbf ?? now,
    exp: opts.exp ?? now + 60,
    jti: opts.jti ?? uuidv7(),
  };
  return new jose.SignJWT(payload)
    .setProtectedHeader({
      alg: opts.alg ?? 'EdDSA',
      kid: opts.kid ?? world.signingKey.kid,
      typ: 'JWT',
    })
    .sign(world.signingKey.privateKey);
}

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

describe('verifier', () => {
  let world: SeedWorld;

  beforeEach(async () => {
    world = await seedWorld();
  });

  afterEach(async () => {
    await destroyWorld(world);
  });

  function buildVerifier() {
    const signingKeys = new Map([[world.signingKey.kid, world.signingKey]]);
    const repo = createParticipantsReadRepo(world.db);
    return loadBlocklist(world.db).then((blocklist) =>
      createVerifier({
        signingKeys,
        blocklist,
        participantsRepo: repo,
        hiveStableIdentifier: world.hiveId,
      }),
    );
  }

  // ---------- Step 1: Bearer header ----------

  it('CREDENTIAL_MISSING when the header is undefined', async () => {
    const verifier = await buildVerifier();
    await expectAuthError(verifier.verify(undefined), 'CREDENTIAL_MISSING');
  });

  it('CREDENTIAL_MISSING when the header is empty', async () => {
    const verifier = await buildVerifier();
    await expectAuthError(verifier.verify(''), 'CREDENTIAL_MISSING');
  });

  it('CREDENTIAL_MISSING when the header lacks the Bearer prefix', async () => {
    const verifier = await buildVerifier();
    await expectAuthError(verifier.verify('Basic dXNlcjpwYXNz'), 'CREDENTIAL_MISSING');
  });

  it('CREDENTIAL_MISSING when Bearer is followed by empty token', async () => {
    const verifier = await buildVerifier();
    await expectAuthError(verifier.verify('Bearer    '), 'CREDENTIAL_MISSING');
  });

  it('accepts case-insensitive bearer scheme (lowercase "bearer")', async () => {
    const verifier = await buildVerifier();
    const token = await signWith(world, world.adminHivekeeperId);
    const ctx = await verifier.verify(`bearer ${token}`);
    expect(ctx.participantId).toBe(world.adminHivekeeperId);
  });

  // ---------- Step 3: signature, kid, iss/aud, exp/nbf ----------

  it('CREDENTIAL_INAUTHENTIC{kid_unknown} when the kid is not in the map', async () => {
    const verifier = await buildVerifier();
    const token = await signWith(world, world.adminHivekeeperId, {
      kid: 'a'.repeat(32), // doesn't match world.signingKey.kid
    });
    await expectAuthError(
      verifier.verify(`Bearer ${token}`),
      'CREDENTIAL_INAUTHENTIC',
      'kid_unknown',
    );
  });

  it('CREDENTIAL_INAUTHENTIC{signature} when signed by a different key with same kid', async () => {
    const verifier = await buildVerifier();
    const otherKey = generateKeypair();
    const token = await new jose.SignJWT({
      sub: world.adminHivekeeperId,
      iss: world.hiveId,
      aud: world.hiveId,
      iat: Math.floor(Date.now() / 1000),
      nbf: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60,
      jti: uuidv7(),
    })
      .setProtectedHeader({
        alg: 'EdDSA',
        kid: world.signingKey.kid, // claims the world's kid
        typ: 'JWT',
      })
      .sign(otherKey.privateKey); // but signs with another key
    await expectAuthError(
      verifier.verify(`Bearer ${token}`),
      'CREDENTIAL_INAUTHENTIC',
      'signature',
    );
  });

  it('CREDENTIAL_EXPIRED when exp is in the past', async () => {
    const verifier = await buildVerifier();
    const past = Math.floor(Date.now() / 1000) - 3600;
    const token = await signWith(world, world.adminHivekeeperId, {
      iat: past - 60,
      nbf: past - 60,
      exp: past,
    });
    await expectAuthError(verifier.verify(`Bearer ${token}`), 'CREDENTIAL_EXPIRED');
  });

  it('CREDENTIAL_NOT_YET_VALID when nbf is far in the future', async () => {
    const verifier = await buildVerifier();
    const future = Math.floor(Date.now() / 1000) + 3600;
    const token = await signWith(world, world.adminHivekeeperId, {
      nbf: future,
      exp: future + 60,
    });
    await expectAuthError(verifier.verify(`Bearer ${token}`), 'CREDENTIAL_NOT_YET_VALID');
  });

  it('CREDENTIAL_INAUTHENTIC{iss_aud_mismatch} when iss is wrong', async () => {
    const verifier = await buildVerifier();
    const token = await signWith(world, world.adminHivekeeperId, {
      iss: '019dffff-0000-0000-0000-000000000999',
    });
    await expectAuthError(
      verifier.verify(`Bearer ${token}`),
      'CREDENTIAL_INAUTHENTIC',
      'iss_aud_mismatch',
    );
  });

  it('CREDENTIAL_INAUTHENTIC{iss_aud_mismatch} when aud is wrong', async () => {
    const verifier = await buildVerifier();
    const token = await signWith(world, world.adminHivekeeperId, {
      aud: '019dffff-0000-0000-0000-000000000999',
    });
    await expectAuthError(
      verifier.verify(`Bearer ${token}`),
      'CREDENTIAL_INAUTHENTIC',
      'iss_aud_mismatch',
    );
  });

  it('CREDENTIAL_INAUTHENTIC{malformed} when the token is junk text', async () => {
    const verifier = await buildVerifier();
    await expectAuthError(
      verifier.verify('Bearer not-a-real-jwt'),
      'CREDENTIAL_INAUTHENTIC',
      'malformed',
    );
  });

  // ---------- Step 4: blocklist ----------

  it('CREDENTIAL_REVOKED when jti is in the blocklist', async () => {
    const repo = createParticipantsReadRepo(world.db);
    const blocklist = await loadBlocklist(world.db);
    const jti = uuidv7();
    await blocklist.add({
      jti,
      credentialExpiresAt: new Date(Date.now() + 60_000),
    });
    const verifier = createVerifier({
      signingKeys: new Map([[world.signingKey.kid, world.signingKey]]),
      blocklist,
      participantsRepo: repo,
      hiveStableIdentifier: world.hiveId,
    });
    const token = await signWith(world, world.adminHivekeeperId, { jti });
    await expectAuthError(verifier.verify(`Bearer ${token}`), 'CREDENTIAL_REVOKED');
  });

  // ---------- Step 6: participant lookup ----------

  it('PARTICIPANT_NOT_FOUND when sub does not match any participant', async () => {
    const verifier = await buildVerifier();
    const fakeId = uuidv7();
    const token = await signWith(world, fakeId);
    await expectAuthError(verifier.verify(`Bearer ${token}`), 'PARTICIPANT_NOT_FOUND');
  });

  // ---------- Step 7: state ----------

  it('PARTICIPANT_NOT_ACTIVE{revoked} when the hivekeeper has been revoked', async () => {
    const verifier = await buildVerifier();
    // First create a token while still active.
    const token = await signWith(world, world.adminHivekeeperId);
    // Then revoke the hivekeeper.
    await markHivekeeperRevoked(world, world.adminHivekeeperId);
    await expectAuthError(verifier.verify(`Bearer ${token}`), 'PARTICIPANT_NOT_ACTIVE', 'revoked');
  });

  it('PARTICIPANT_NOT_ACTIVE{revoked} when the agent has been revoked', async () => {
    const verifier = await buildVerifier();
    const token = await signWith(world, world.workerAgentId);
    await markAgentRevoked(world, world.workerAgentId);
    await expectAuthError(verifier.verify(`Bearer ${token}`), 'PARTICIPANT_NOT_ACTIVE', 'revoked');
  });

  // ---------- Happy path ----------

  it('happy path — admin hivekeeper yields IdentityContext with current.isAdmin=true', async () => {
    const verifier = await buildVerifier();
    const token = await signWith(world, world.adminHivekeeperId);
    const ctx = await verifier.verify(`Bearer ${token}`);
    expect(ctx.participantId).toBe(world.adminHivekeeperId);
    expect(ctx.kind).toBe('hivekeeper');
    expect(ctx.hiveId).toBe(world.hiveId);
    expect(ctx.colonyId).toBe(world.colonyId);
    expect(ctx.current.state).toBe('active');
    expect(ctx.current.isAdmin).toBe(true);
  });

  it('IdentityContext.hiveName is loaded from hives.name during verify (per ADR-015)', async () => {
    const verifier = await buildVerifier();
    const token = await signWith(world, world.adminHivekeeperId);
    const ctx = await verifier.verify(`Bearer ${token}`);
    expect(ctx.hiveName).toBe('Test Hive');
  });

  it('IdentityContext.hiveName reflects current hives.name when mutated mid-deployment', async () => {
    const verifier = await buildVerifier();
    await world.db
      .updateTable('hives')
      .set({ name: 'renamed' })
      .where('id', '=', world.hiveId)
      .execute();
    const token = await signWith(world, world.adminHivekeeperId);
    const ctx = await verifier.verify(`Bearer ${token}`);
    expect(ctx.hiveName).toBe('renamed');
  });

  it('happy path — issued token via issuer round-trips through verifier', async () => {
    const repo = createParticipantsReadRepo(world.db);
    const issuer = createIssuer({
      signingKey: world.signingKey,
      participantsRepo: repo,
      hiveStableIdentifier: world.hiveId,
      defaultTtlMs: 60_000,
      db: world.db,
    });
    const blocklist = await loadBlocklist(world.db);
    const verifier = createVerifier({
      signingKeys: new Map([[world.signingKey.kid, world.signingKey]]),
      blocklist,
      participantsRepo: repo,
      hiveStableIdentifier: world.hiveId,
    });
    const issued = await issuer.issueCredential({
      participantId: world.workerAgentId,
    });
    const ctx = await verifier.verify(`Bearer ${issued.jwt}`);
    expect(ctx.kind).toBe('worker');
    expect(ctx.ownerId).toBe(world.adminHivekeeperId);
    expect(ctx.current.type).toBe('worker');
    expect(ctx.snapshot.capabilities).toEqual(world.workerCapabilities);
  });
});
