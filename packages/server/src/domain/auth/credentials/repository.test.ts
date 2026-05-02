import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';

import { dateToIso, jsonStringify } from '#persistence/type-mappers.js';
import { destroyWorld, seedWorld, type SeedWorld } from '../test-helpers.js';
import { createCredentialsReadRepo } from './repository.js';

// Helper: insert a credential row directly. Bypasses issuer/rotator so each
// test can craft the exact (issuedAt, expiresAt, revoked_at, hive scoping)
// scenario it needs.
async function insertCredential(
  world: SeedWorld,
  args: {
    jti?: string;
    participantId: string;
    participantKind: 'hivekeeper' | 'worker' | 'scout';
    issuedAt: Date;
    expiresAt: Date;
    revokedAt?: Date | null;
    kid?: string;
  },
): Promise<string> {
  const jti = args.jti ?? uuidv7();
  await world.db
    .insertInto('credentials')
    .values({
      jti,
      participant_id: args.participantId,
      participant_kind: args.participantKind,
      kid: args.kid ?? world.signingKey.kid,
      issued_at: dateToIso(args.issuedAt),
      not_before: dateToIso(args.issuedAt),
      expires_at: dateToIso(args.expiresAt),
      snapshot: jsonStringify({ marker: 'fixture' }),
      issued_by: null,
      revoked_at: args.revokedAt ? dateToIso(args.revokedAt) : null,
    })
    .execute();
  return jti;
}

describe('createCredentialsReadRepo', () => {
  let world: SeedWorld;

  beforeEach(async () => {
    world = await seedWorld();
  });

  afterEach(async () => {
    await destroyWorld(world);
  });

  describe('findActiveCredentialByParticipant', () => {
    it('returns the active credential when one exists for the hivekeeper participant', async () => {
      const repo = createCredentialsReadRepo(world.db);
      const now = new Date('2026-05-02T12:00:00.000Z');
      const jti = await insertCredential(world, {
        participantId: world.adminHivekeeperId,
        participantKind: 'hivekeeper',
        issuedAt: new Date('2026-05-02T11:00:00.000Z'),
        expiresAt: new Date('2026-05-02T13:00:00.000Z'),
        revokedAt: null,
      });

      const result = await repo.findActiveCredentialByParticipant(
        world.hiveId,
        world.adminHivekeeperId,
        now,
      );

      expect(result).not.toBeNull();
      expect(result?.jti).toBe(jti);
      expect(result?.participantId).toBe(world.adminHivekeeperId);
      expect(result?.participantKind).toBe('hivekeeper');
      expect(result?.isRevoked).toBe(false);
      expect(result?.revokedAt).toBeNull();
    });

    it('returns the active credential when one exists for an agent participant', async () => {
      const repo = createCredentialsReadRepo(world.db);
      const now = new Date('2026-05-02T12:00:00.000Z');
      const jti = await insertCredential(world, {
        participantId: world.workerAgentId,
        participantKind: 'worker',
        issuedAt: new Date('2026-05-02T11:00:00.000Z'),
        expiresAt: new Date('2026-05-02T13:00:00.000Z'),
        revokedAt: null,
      });

      const result = await repo.findActiveCredentialByParticipant(
        world.hiveId,
        world.workerAgentId,
        now,
      );

      expect(result?.jti).toBe(jti);
      expect(result?.participantKind).toBe('worker');
    });

    it('returns null when participant has no credential at all', async () => {
      const repo = createCredentialsReadRepo(world.db);
      const now = new Date('2026-05-02T12:00:00.000Z');

      const result = await repo.findActiveCredentialByParticipant(
        world.hiveId,
        world.nonAdminHivekeeperId,
        now,
      );

      expect(result).toBeNull();
    });

    it('returns null when the participant only has a revoked credential', async () => {
      const repo = createCredentialsReadRepo(world.db);
      const now = new Date('2026-05-02T12:00:00.000Z');
      await insertCredential(world, {
        participantId: world.adminHivekeeperId,
        participantKind: 'hivekeeper',
        issuedAt: new Date('2026-05-02T11:00:00.000Z'),
        expiresAt: new Date('2026-05-02T13:00:00.000Z'),
        revokedAt: new Date('2026-05-02T11:30:00.000Z'),
      });

      const result = await repo.findActiveCredentialByParticipant(
        world.hiveId,
        world.adminHivekeeperId,
        now,
      );

      expect(result).toBeNull();
    });

    it('returns null when the participant only has an expired credential', async () => {
      const repo = createCredentialsReadRepo(world.db);
      const now = new Date('2026-05-02T12:00:00.000Z');
      await insertCredential(world, {
        participantId: world.adminHivekeeperId,
        participantKind: 'hivekeeper',
        issuedAt: new Date('2026-05-02T10:00:00.000Z'),
        expiresAt: new Date('2026-05-02T11:00:00.000Z'),
        revokedAt: null,
      });

      const result = await repo.findActiveCredentialByParticipant(
        world.hiveId,
        world.adminHivekeeperId,
        now,
      );

      expect(result).toBeNull();
    });

    it('returns null when expires_at == now (strict greater-than per ADR-020)', async () => {
      const repo = createCredentialsReadRepo(world.db);
      const now = new Date('2026-05-02T12:00:00.000Z');
      await insertCredential(world, {
        participantId: world.adminHivekeeperId,
        participantKind: 'hivekeeper',
        issuedAt: new Date('2026-05-02T11:00:00.000Z'),
        expiresAt: now,
        revokedAt: null,
      });

      const result = await repo.findActiveCredentialByParticipant(
        world.hiveId,
        world.adminHivekeeperId,
        now,
      );

      expect(result).toBeNull();
    });

    it('returns null when participantId belongs to a different Hive (cross-hive scoping)', async () => {
      const repo = createCredentialsReadRepo(world.db);
      const now = new Date('2026-05-02T12:00:00.000Z');
      await insertCredential(world, {
        participantId: world.adminHivekeeperId,
        participantKind: 'hivekeeper',
        issuedAt: new Date('2026-05-02T11:00:00.000Z'),
        expiresAt: new Date('2026-05-02T13:00:00.000Z'),
        revokedAt: null,
      });

      const otherHiveId = uuidv7();
      const result = await repo.findActiveCredentialByParticipant(
        otherHiveId,
        world.adminHivekeeperId,
        now,
      );

      expect(result).toBeNull();
    });

    it('returns the most-recent credential when multiple are active (defense-in-depth)', async () => {
      // The v0.1 OSS invariant is "at most 1 active credential per participant"
      // (rotate revokes the previous JTI atomically). This test pretends the
      // invariant got violated (concurrent issuer with no rotate) and asserts
      // the repo still returns deterministic output: the credential with the
      // largest issued_at.
      const repo = createCredentialsReadRepo(world.db);
      const now = new Date('2026-05-02T12:00:00.000Z');
      await insertCredential(world, {
        jti: uuidv7(),
        participantId: world.adminHivekeeperId,
        participantKind: 'hivekeeper',
        issuedAt: new Date('2026-05-02T11:00:00.000Z'),
        expiresAt: new Date('2026-05-02T13:00:00.000Z'),
        revokedAt: null,
      });
      const newerJti = await insertCredential(world, {
        jti: uuidv7(),
        participantId: world.adminHivekeeperId,
        participantKind: 'hivekeeper',
        issuedAt: new Date('2026-05-02T11:30:00.000Z'),
        expiresAt: new Date('2026-05-02T13:30:00.000Z'),
        revokedAt: null,
      });

      const result = await repo.findActiveCredentialByParticipant(
        world.hiveId,
        world.adminHivekeeperId,
        now,
      );

      expect(result?.jti).toBe(newerJti);
    });

    it('skips revoked entries when both an active and a revoked credential exist for the participant', async () => {
      // Realistic post-rotate scenario: the previous JTI is revoked, the new
      // one is active. Order them so issued_at descending visits the revoked
      // one first → confirms the WHERE filter (not just ORDER BY) does the work.
      const repo = createCredentialsReadRepo(world.db);
      const now = new Date('2026-05-02T12:00:00.000Z');
      const oldActiveJti = await insertCredential(world, {
        jti: uuidv7(),
        participantId: world.adminHivekeeperId,
        participantKind: 'hivekeeper',
        issuedAt: new Date('2026-05-02T11:00:00.000Z'),
        expiresAt: new Date('2026-05-02T13:00:00.000Z'),
        revokedAt: null,
      });
      // The "revoked, but more-recently issued" entry — would win ORDER BY
      // alone but must lose because of the IS NULL filter.
      await insertCredential(world, {
        jti: uuidv7(),
        participantId: world.adminHivekeeperId,
        participantKind: 'hivekeeper',
        issuedAt: new Date('2026-05-02T11:45:00.000Z'),
        expiresAt: new Date('2026-05-02T13:45:00.000Z'),
        revokedAt: new Date('2026-05-02T11:45:01.000Z'),
      });

      const result = await repo.findActiveCredentialByParticipant(
        world.hiveId,
        world.adminHivekeeperId,
        now,
      );

      expect(result?.jti).toBe(oldActiveJti);
    });
  });
});
