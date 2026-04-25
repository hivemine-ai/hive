import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { destroyWorld, seedWorld, type SeedWorld } from '../test-helpers.js';
import type { AuthError } from '../errors.js';
import { createParticipantsReadRepo } from '../participants/repository.js';
import { loadBlocklist } from './blocklist.js';
import { createIssuer } from './issuer.js';
import { createRevoker } from './revoker.js';
import { createVerifier } from './verifier.js';

describe('revoker', () => {
  let world: SeedWorld;

  beforeEach(async () => {
    world = await seedWorld();
  });

  afterEach(async () => {
    await destroyWorld(world);
  });

  it('revokes a credential — blocklist contains the jti and verify rejects with CREDENTIAL_REVOKED', async () => {
    const repo = createParticipantsReadRepo(world.db);
    const issuer = createIssuer({
      signingKey: world.signingKey,
      participantsRepo: repo,
      hiveStableIdentifier: world.hiveId,
      defaultTtlMs: 60_000,
      db: world.db,
    });
    const blocklist = await loadBlocklist(world.db);
    const revoker = createRevoker({ blocklist, db: world.db });
    const verifier = createVerifier({
      signingKeys: new Map([[world.signingKey.kid, world.signingKey]]),
      blocklist,
      participantsRepo: repo,
      hiveStableIdentifier: world.hiveId,
    });

    const issued = await issuer.issueCredential({
      participantId: world.adminHivekeeperId,
    });
    expect(blocklist.contains(issued.jti)).toBe(false);
    await revoker.revokeCredential({ jti: issued.jti, reason: 'leak' });
    expect(blocklist.contains(issued.jti)).toBe(true);

    try {
      await verifier.verify(`Bearer ${issued.jwt}`);
      expect.fail('expected throw');
    } catch (err) {
      expect((err as AuthError).code).toBe('CREDENTIAL_REVOKED');
    }
  });

  it('is idempotent on already-revoked jtis (no error, blocklist still contains it)', async () => {
    const repo = createParticipantsReadRepo(world.db);
    const issuer = createIssuer({
      signingKey: world.signingKey,
      participantsRepo: repo,
      hiveStableIdentifier: world.hiveId,
      defaultTtlMs: 60_000,
      db: world.db,
    });
    const blocklist = await loadBlocklist(world.db);
    const revoker = createRevoker({ blocklist, db: world.db });

    const issued = await issuer.issueCredential({
      participantId: world.adminHivekeeperId,
    });
    await revoker.revokeCredential({ jti: issued.jti });
    await expect(revoker.revokeCredential({ jti: issued.jti })).resolves.toBeUndefined();
    expect(blocklist.contains(issued.jti)).toBe(true);
  });
});
