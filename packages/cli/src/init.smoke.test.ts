// End-to-end smoke test for PRY-002 milestone 22.
// Runs the full flow against SQLite on disk (not in-memory) to mirror what
// `hivectl init` does in production. Each sub-case maps 1:1 to an AC bullet.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createDb,
  createIssuer,
  createParticipantsReadRepo,
  createParticipantsWriteRepo,
  createRevoker,
  createRotator,
  createVerifier,
  isAuthError,
  loadAllKeypairs,
  loadBlocklist,
  type AuthError,
  type CallerContext,
  type DbConfig,
} from '@hive/server';

import { performInit } from './init.js';

const SYSTEM_CALLER: CallerContext = {
  kind: 'system',
  osUser: 'smoke-tests',
  operatorNote: 'pry-002 smoke',
};

describe('PRY-002 smoke E2E (SQLite file)', () => {
  let workDir: string;
  let dbPath: string;
  let keysDir: string;
  let dbConfig: DbConfig;

  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-smoke-'));
    dbPath = path.join(workDir, 'hive.sqlite');
    keysDir = path.join(workDir, 'keys');
    dbConfig = { dialect: 'sqlite', url: `sqlite:${dbPath}`, sqliteWal: false };
  });

  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it('22a: hivectl init → JWT verifies, IdentityContext kind=hivekeeper, isAdmin=true', async () => {
    const result = await performInit({
      db: dbConfig,
      adminEmail: 'admin@example.com',
      adminDisplayName: 'Admin',
      keysDir,
      hiveName: 'Smoke Hive',
    });
    expect(result.initialCredential.jwt.split('.').length).toBe(3);

    const db = createDb(dbConfig);
    try {
      const repo = createParticipantsReadRepo(db);
      const blocklist = await loadBlocklist(db);
      const signingKeys = await loadAllKeypairs({ keysDir });
      const verifier = createVerifier({
        signingKeys,
        blocklist,
        participantsRepo: repo,
        hiveStableIdentifier: result.hiveId,
      });
      const ctx = await verifier.verify(`Bearer ${result.initialCredential.jwt}`);
      expect(ctx.kind).toBe('hivekeeper');
      expect(ctx.participantId).toBe(result.adminHivekeeperId);
      expect(ctx.current.isAdmin).toBe(true);
      expect(ctx.hiveId).toBe(result.hiveId);
      expect(ctx.colonyId).toBe(result.colonyId);
    } finally {
      await db.destroy();
    }
  });

  it('22b: createAgent for Worker and Scout → both created (cell stub no-op)', async () => {
    const init = await performInit({
      db: dbConfig,
      adminEmail: 'admin@example.com',
      keysDir,
    });
    const db = createDb(dbConfig);
    try {
      const writeRepo = createParticipantsWriteRepo(db);
      const worker = await writeRepo.createAgent(
        {
          hiveId: init.hiveId,
          colonyId: init.colonyId,
          ownerId: init.adminHivekeeperId,
          name: 'analyst',
          type: 'worker',
          capabilities: ['cell.send', 'cell.read'],
        },
        SYSTEM_CALLER,
      );
      const scout = await writeRepo.createAgent(
        {
          hiveId: init.hiveId,
          colonyId: init.colonyId,
          ownerId: init.adminHivekeeperId,
          name: 'finder',
          type: 'scout',
        },
        SYSTEM_CALLER,
      );
      expect(worker.type).toBe('worker');
      expect(scout.type).toBe('scout');
      expect(worker.capabilities).toEqual(['cell.send', 'cell.read']);
    } finally {
      await db.destroy();
    }
  });

  it('22c: issueCredential for an Agent yields a JWT verifiable as that Agent', async () => {
    const init = await performInit({
      db: dbConfig,
      adminEmail: 'admin@example.com',
      keysDir,
    });
    const db = createDb(dbConfig);
    try {
      const readRepo = createParticipantsReadRepo(db);
      const writeRepo = createParticipantsWriteRepo(db);
      const worker = await writeRepo.createAgent(
        {
          hiveId: init.hiveId,
          colonyId: init.colonyId,
          ownerId: init.adminHivekeeperId,
          name: 'a1',
          type: 'worker',
          capabilities: ['cell.send'],
        },
        SYSTEM_CALLER,
      );
      const issuer = createIssuer({
        signingKey: init.signingKey,
        participantsRepo: readRepo,
        hiveStableIdentifier: init.hiveId,
        defaultTtlMs: 60_000,
        db,
      });
      const issued = await issuer.issueCredential({ participantId: worker.id });
      const blocklist = await loadBlocklist(db);
      const signingKeys = await loadAllKeypairs({ keysDir });
      const verifier = createVerifier({
        signingKeys,
        blocklist,
        participantsRepo: readRepo,
        hiveStableIdentifier: init.hiveId,
      });
      const ctx = await verifier.verify(`Bearer ${issued.jwt}`);
      expect(ctx.kind).toBe('worker');
      expect(ctx.participantId).toBe(worker.id);
      expect(ctx.snapshot.capabilities).toEqual(['cell.send']);
    } finally {
      await db.destroy();
    }
  });

  it('22d: rotateCredential → new JWT verifies, old JWT rejected as CREDENTIAL_REVOKED', async () => {
    const init = await performInit({
      db: dbConfig,
      adminEmail: 'admin@example.com',
      keysDir,
    });
    const db = createDb(dbConfig);
    try {
      const readRepo = createParticipantsReadRepo(db);
      const blocklist = await loadBlocklist(db);
      const signingKeys = await loadAllKeypairs({ keysDir });
      const issuer = createIssuer({
        signingKey: init.signingKey,
        participantsRepo: readRepo,
        hiveStableIdentifier: init.hiveId,
        defaultTtlMs: 60_000,
        db,
      });
      const rotator = createRotator({
        signingKey: init.signingKey,
        blocklist,
        hiveStableIdentifier: init.hiveId,
        defaultTtlMs: 60_000,
        db,
      });
      const verifier = createVerifier({
        signingKeys,
        blocklist,
        participantsRepo: readRepo,
        hiveStableIdentifier: init.hiveId,
      });

      const original = await issuer.issueCredential({
        participantId: init.adminHivekeeperId,
      });
      const rotated = await rotator.rotateCredential({ currentJti: original.jti });

      const ctxNew = await verifier.verify(`Bearer ${rotated.jwt}`);
      expect(ctxNew.snapshot.credentialJti).toBe(rotated.jti);

      await expect(verifier.verify(`Bearer ${original.jwt}`)).rejects.toMatchObject({
        code: 'CREDENTIAL_REVOKED',
      });
    } finally {
      await db.destroy();
    }
  });

  it('22e: revokeCredential → JWT rejected as CREDENTIAL_REVOKED', async () => {
    const init = await performInit({
      db: dbConfig,
      adminEmail: 'admin@example.com',
      keysDir,
    });
    const db = createDb(dbConfig);
    try {
      const readRepo = createParticipantsReadRepo(db);
      const blocklist = await loadBlocklist(db);
      const signingKeys = await loadAllKeypairs({ keysDir });
      const issuer = createIssuer({
        signingKey: init.signingKey,
        participantsRepo: readRepo,
        hiveStableIdentifier: init.hiveId,
        defaultTtlMs: 60_000,
        db,
      });
      const revoker = createRevoker({ blocklist, db });
      const verifier = createVerifier({
        signingKeys,
        blocklist,
        participantsRepo: readRepo,
        hiveStableIdentifier: init.hiveId,
      });

      const issued = await issuer.issueCredential({
        participantId: init.adminHivekeeperId,
      });
      await revoker.revokeCredential({ jti: issued.jti, reason: 'leak' });
      await expect(verifier.verify(`Bearer ${issued.jwt}`)).rejects.toMatchObject({
        code: 'CREDENTIAL_REVOKED',
      });
    } finally {
      await db.destroy();
    }
  });

  it('22f: revokeAgent → state revoked, JWT rejected as PARTICIPANT_NOT_ACTIVE', async () => {
    const init = await performInit({
      db: dbConfig,
      adminEmail: 'admin@example.com',
      keysDir,
    });
    const db = createDb(dbConfig);
    try {
      const readRepo = createParticipantsReadRepo(db);
      const writeRepo = createParticipantsWriteRepo(db);
      const blocklist = await loadBlocklist(db);
      const signingKeys = await loadAllKeypairs({ keysDir });
      const issuer = createIssuer({
        signingKey: init.signingKey,
        participantsRepo: readRepo,
        hiveStableIdentifier: init.hiveId,
        defaultTtlMs: 60_000,
        db,
      });
      const verifier = createVerifier({
        signingKeys,
        blocklist,
        participantsRepo: readRepo,
        hiveStableIdentifier: init.hiveId,
      });
      const worker = await writeRepo.createAgent(
        {
          hiveId: init.hiveId,
          colonyId: init.colonyId,
          ownerId: init.adminHivekeeperId,
          name: 'w-revoke',
          type: 'worker',
        },
        SYSTEM_CALLER,
      );
      const issued = await issuer.issueCredential({ participantId: worker.id });
      await writeRepo.revokeAgent(worker.id, SYSTEM_CALLER);

      const after = await readRepo.findAgentById(worker.id);
      expect(after?.state).toBe('revoked');
      await expect(verifier.verify(`Bearer ${issued.jwt}`)).rejects.toMatchObject({
        code: 'PARTICIPANT_NOT_ACTIVE',
        subCode: 'revoked',
      });
    } finally {
      await db.destroy();
    }
  });

  it('22g: listAgents with pagination — keyset cursor is reproducible (no duplicates across pages)', async () => {
    const init = await performInit({
      db: dbConfig,
      adminEmail: 'admin@example.com',
      keysDir,
    });
    const db = createDb(dbConfig);
    try {
      const writeRepo = createParticipantsWriteRepo(db);
      // Create 12 agents.
      for (let i = 0; i < 12; i++) {
        await writeRepo.createAgent(
          {
            hiveId: init.hiveId,
            colonyId: init.colonyId,
            ownerId: init.adminHivekeeperId,
            name: `pg-${i}`,
            type: i % 2 === 0 ? 'worker' : 'scout',
          },
          SYSTEM_CALLER,
        );
      }
      const seen = new Set<string>();
      let cursor: { createdAt: Date; id: string } | null = null;
      let pages = 0;
      do {
        const page = await writeRepo.listAgents({
          hiveId: init.hiveId,
          pagination: { cursor, limit: 4 },
        });
        for (const a of page.agents) {
          expect(seen.has(a.id)).toBe(false);
          seen.add(a.id);
        }
        cursor = page.nextCursor;
        pages++;
        if (pages > 10) throw new Error('too many pages');
      } while (cursor !== null);
      expect(seen.size).toBe(12);
    } finally {
      await db.destroy();
    }
  });

  it('22h: listHivekeepers shows the admin Hivekeeper with isAdmin=true', async () => {
    const init = await performInit({
      db: dbConfig,
      adminEmail: 'admin@example.com',
      adminDisplayName: 'The Admin',
      keysDir,
    });
    const db = createDb(dbConfig);
    try {
      const writeRepo = createParticipantsWriteRepo(db);
      const result = await writeRepo.listHivekeepers({
        hiveId: init.hiveId,
        pagination: { cursor: null, limit: 50 },
      });
      expect(result.hivekeepers.length).toBe(1);
      expect(result.hivekeepers[0]?.isAdmin).toBe(true);
      expect(result.hivekeepers[0]?.email).toBe('admin@example.com');
      expect(result.hivekeepers[0]?.displayName).toBe('The Admin');
    } finally {
      await db.destroy();
    }
  });

  it('22i: double `hivectl init` over the same DB → HIVE_ALREADY_INITIALIZED, no state mutated', async () => {
    await performInit({
      db: dbConfig,
      adminEmail: 'admin@example.com',
      keysDir,
    });
    try {
      await performInit({
        db: dbConfig,
        adminEmail: 'admin2@example.com',
        keysDir,
      });
      throw new Error('expected HIVE_ALREADY_INITIALIZED');
    } catch (err) {
      expect(isAuthError(err)).toBe(true);
      expect((err as AuthError).code).toBe('HIVE_ALREADY_INITIALIZED');
    }

    // Sanity: only one Hive row present, only one Hivekeeper.
    const db = createDb(dbConfig);
    try {
      const hives = await db.selectFrom('hives').selectAll().execute();
      expect(hives.length).toBe(1);
      const keepers = await db.selectFrom('hivekeepers').selectAll().execute();
      expect(keepers.length).toBe(1);
      expect(keepers[0]?.email).toBe('admin@example.com');
    } finally {
      await db.destroy();
    }
  });
});
