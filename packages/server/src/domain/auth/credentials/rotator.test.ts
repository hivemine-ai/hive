import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { destroyWorld, seedWorld, type SeedWorld } from '../test-helpers.js';
import { isAuthError } from '../errors.js';
import type { AuthError } from '../errors.js';
import { createParticipantsReadRepo } from '#domain/auth/participants/repository.js';
import { loadBlocklist } from './blocklist.js';
import { createIssuer } from './issuer.js';
import { createRotator } from './rotator.js';
import { createVerifier } from './verifier.js';

describe('rotator', () => {
  let world: SeedWorld;

  beforeEach(async () => {
    world = await seedWorld();
  });

  afterEach(async () => {
    await destroyWorld(world);
  });

  it('emits a new credential and adds the previous jti to the blocklist atomically', async () => {
    const repo = createParticipantsReadRepo(world.db);
    const issuer = createIssuer({
      signingKey: world.signingKey,
      participantsRepo: repo,
      hiveStableIdentifier: world.hiveId,
      defaultTtlMs: 60_000,
      db: world.db,
    });
    const blocklist = await loadBlocklist(world.db);
    const rotator = createRotator({
      signingKey: world.signingKey,
      blocklist,
      hiveStableIdentifier: world.hiveId,
      defaultTtlMs: 60_000,
      db: world.db,
    });

    const original = await issuer.issueCredential({
      participantId: world.adminHivekeeperId,
    });
    const rotated = await rotator.rotateCredential({
      currentJti: original.jti,
      requestedBy: world.adminHivekeeperId,
    });

    expect(rotated.jti).not.toBe(original.jti);
    expect(rotated.kid).toBe(world.signingKey.kid);
    expect(blocklist.contains(original.jti)).toBe(true);
    expect(blocklist.contains(rotated.jti)).toBe(false);

    // The original credential row is marked revoked_at.
    const originalRow = await world.db
      .selectFrom('credentials')
      .selectAll()
      .where('jti', '=', original.jti)
      .executeTakeFirstOrThrow();
    expect(originalRow.revoked_at).not.toBeNull();
  });

  it('the rotated credential verifies and the original is rejected as CREDENTIAL_REVOKED', async () => {
    const repo = createParticipantsReadRepo(world.db);
    const issuer = createIssuer({
      signingKey: world.signingKey,
      participantsRepo: repo,
      hiveStableIdentifier: world.hiveId,
      defaultTtlMs: 60_000,
      db: world.db,
    });
    const blocklist = await loadBlocklist(world.db);
    const rotator = createRotator({
      signingKey: world.signingKey,
      blocklist,
      hiveStableIdentifier: world.hiveId,
      defaultTtlMs: 60_000,
      db: world.db,
    });
    const verifier = createVerifier({
      signingKeys: new Map([[world.signingKey.kid, world.signingKey]]),
      blocklist,
      participantsRepo: repo,
      hiveStableIdentifier: world.hiveId,
    });

    const original = await issuer.issueCredential({
      participantId: world.workerAgentId,
    });
    const rotated = await rotator.rotateCredential({
      currentJti: original.jti,
    });

    const ctx = await verifier.verify(`Bearer ${rotated.jwt}`);
    expect(ctx.kind).toBe('worker');
    expect(ctx.participantId).toBe(world.workerAgentId);

    try {
      await verifier.verify(`Bearer ${original.jwt}`);
      expect.fail('expected throw');
    } catch (err) {
      expect(isAuthError(err)).toBe(true);
      expect((err as AuthError).code).toBe('CREDENTIAL_REVOKED');
    }
  });

  it('throws CREDENTIAL_ALREADY_REVOKED when the currentJti is already in the blocklist', async () => {
    const repo = createParticipantsReadRepo(world.db);
    const issuer = createIssuer({
      signingKey: world.signingKey,
      participantsRepo: repo,
      hiveStableIdentifier: world.hiveId,
      defaultTtlMs: 60_000,
      db: world.db,
    });
    const blocklist = await loadBlocklist(world.db);
    const rotator = createRotator({
      signingKey: world.signingKey,
      blocklist,
      hiveStableIdentifier: world.hiveId,
      defaultTtlMs: 60_000,
      db: world.db,
    });

    const original = await issuer.issueCredential({
      participantId: world.adminHivekeeperId,
    });
    await rotator.rotateCredential({ currentJti: original.jti });

    try {
      await rotator.rotateCredential({ currentJti: original.jti });
      expect.fail('expected throw');
    } catch (err) {
      expect((err as AuthError).code).toBe('CREDENTIAL_ALREADY_REVOKED');
    }
  });
});
