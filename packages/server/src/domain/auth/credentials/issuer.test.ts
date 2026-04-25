import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';

import { destroyWorld, markAgentRevoked, seedWorld, type SeedWorld } from '../test-helpers.js';
import { isAuthError } from '../errors.js';
import type { AuthError } from '../errors.js';
import { createParticipantsReadRepo } from '../participants/repository.js';
import { createIssuer } from './issuer.js';
import { createVerifier } from './verifier.js';
import { loadBlocklist } from './blocklist.js';

describe('issuer', () => {
  let world: SeedWorld;

  beforeEach(async () => {
    world = await seedWorld();
  });

  afterEach(async () => {
    await destroyWorld(world);
  });

  it('issues a JWT for an active hivekeeper and persists the credential row', async () => {
    const repo = createParticipantsReadRepo(world.db);
    const issuer = createIssuer({
      signingKey: world.signingKey,
      participantsRepo: repo,
      hiveStableIdentifier: world.hiveId,
      defaultTtlMs: 60_000,
      db: world.db,
    });

    const result = await issuer.issueCredential({
      participantId: world.adminHivekeeperId,
    });
    expect(result.jwt.split('.').length).toBe(3);
    expect(result.kid).toBe(world.signingKey.kid);
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const row = await world.db
      .selectFrom('credentials')
      .selectAll()
      .where('jti', '=', result.jti)
      .executeTakeFirst();
    expect(row?.participant_id).toBe(world.adminHivekeeperId);
    expect(row?.participant_kind).toBe('hivekeeper');
    expect(row?.kid).toBe(world.signingKey.kid);
  });

  it('issues a JWT for an active agent with capabilities snapshot', async () => {
    const repo = createParticipantsReadRepo(world.db);
    const issuer = createIssuer({
      signingKey: world.signingKey,
      participantsRepo: repo,
      hiveStableIdentifier: world.hiveId,
      defaultTtlMs: 60_000,
      db: world.db,
    });
    const result = await issuer.issueCredential({
      participantId: world.workerAgentId,
    });
    expect(typeof result.jwt).toBe('string');

    const row = await world.db
      .selectFrom('credentials')
      .selectAll()
      .where('jti', '=', result.jti)
      .executeTakeFirstOrThrow();
    expect(row.participant_kind).toBe('worker');
    const snapshot = JSON.parse(row.snapshot) as { capabilities?: string[] };
    expect(snapshot.capabilities).toEqual(world.workerCapabilities);
  });

  it('round-trips with the verifier (issued JWT verifies and yields IdentityContext)', async () => {
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
      participantId: world.adminHivekeeperId,
    });
    const ctx = await verifier.verify(`Bearer ${issued.jwt}`);
    expect(ctx.participantId).toBe(world.adminHivekeeperId);
    expect(ctx.kind).toBe('hivekeeper');
    expect(ctx.current.isAdmin).toBe(true);
    expect(ctx.snapshot.credentialJti).toBe(issued.jti);
    expect(ctx.snapshot.credentialKid).toBe(world.signingKey.kid);
  });

  it('throws PARTICIPANT_NOT_FOUND_FOR_ISSUE when participantId does not exist', async () => {
    const repo = createParticipantsReadRepo(world.db);
    const issuer = createIssuer({
      signingKey: world.signingKey,
      participantsRepo: repo,
      hiveStableIdentifier: world.hiveId,
      defaultTtlMs: 60_000,
      db: world.db,
    });
    try {
      await issuer.issueCredential({ participantId: uuidv7() });
      expect.fail('expected throw');
    } catch (err) {
      expect(isAuthError(err)).toBe(true);
      expect((err as AuthError).code).toBe('PARTICIPANT_NOT_FOUND_FOR_ISSUE');
    }
  });

  it('throws PARTICIPANT_NOT_ACTIVE when target agent is revoked', async () => {
    await markAgentRevoked(world, world.workerAgentId);
    const repo = createParticipantsReadRepo(world.db);
    const issuer = createIssuer({
      signingKey: world.signingKey,
      participantsRepo: repo,
      hiveStableIdentifier: world.hiveId,
      defaultTtlMs: 60_000,
      db: world.db,
    });
    try {
      await issuer.issueCredential({
        participantId: world.workerAgentId,
      });
      expect.fail('expected throw');
    } catch (err) {
      const e = err as AuthError;
      expect(e.code).toBe('PARTICIPANT_NOT_ACTIVE');
      expect(e.subCode).toBe('revoked');
    }
  });
});
