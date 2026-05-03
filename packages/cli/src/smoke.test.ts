// PRY-007 H21 — End-to-end smoke E2E covering the 11-step Criterio de Done
// of the hivectl + Admin Operations Slice 0 tech spec. Runs against SQLite
// on disk (testcontainers Postgres is the v0.2 deploy target; SQLite is the
// v0.1 OSS default per ADR-008).
//
// Each `it(...)` block maps 1:1 to one of the 11 demoable steps OR to one
// of the AC-11 / AC-12 invariants.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { startCli, stopCli } from '@hive/server';
import type { CliRuntime } from '@hive/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runAuditQuery } from './commands/audit/query.js';
import { runCreateAgent } from './commands/agent/create.js';
import { runListAgents } from './commands/agent/list.js';
import { runRevokeAgent } from './commands/agent/revoke.js';
import { runIssueCredential } from './commands/credential/issue.js';
import { runListCredentials } from './commands/credential/list.js';
import { runRevokeCredential } from './commands/credential/revoke.js';
import { runRotateCredential } from './commands/credential/rotate.js';
import { runListKeepers } from './commands/hive/list-keepers.js';
import { runCreateHivekeeper } from './commands/hivekeeper/create.js';
import { runInit } from './commands/init.js';
import { mapErrorToExit } from '#error/handler.js';
import { EXIT_NOT_FOUND, EXIT_OK, EXIT_PRECONDITION, EXIT_USER_ERROR } from './error/exit-codes.js';
import { formatOutput } from './output/format.js';
import { initSchema } from './output/schemas.js';
import { createLogger } from '@hive/server';
import type { GlobalCliOpts } from './types.js';

const SILENT_LOGGER = createLogger({ level: 'error' });

function makeGlobals(operatorId?: string): GlobalCliOpts {
  const g: GlobalCliOpts = {
    output: 'json',
    yes: true,
    noColor: true,
    verbose: false,
  };
  if (operatorId !== undefined) g.operatorId = operatorId;
  return g;
}

describe('PRY-007 H21 — hivectl Slice 0 smoke E2E (SQLite)', () => {
  let workDir: string;
  let dbPath: string;
  let keysDir: string;
  let originalEnv: { HIVE_DB_URL: string | undefined; HIVE_AUTH_KEYS_DIR: string | undefined };

  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hivectl-smoke-'));
    dbPath = path.join(workDir, 'hive.sqlite');
    keysDir = path.join(workDir, 'keys');
    originalEnv = {
      HIVE_DB_URL: process.env['HIVE_DB_URL'],
      HIVE_AUTH_KEYS_DIR: process.env['HIVE_AUTH_KEYS_DIR'],
    };
    process.env['HIVE_DB_URL'] = `sqlite:${dbPath}`;
    process.env['HIVE_AUTH_KEYS_DIR'] = keysDir;
  });

  afterEach(async () => {
    if (originalEnv.HIVE_DB_URL === undefined) delete process.env['HIVE_DB_URL'];
    else process.env['HIVE_DB_URL'] = originalEnv.HIVE_DB_URL;
    if (originalEnv.HIVE_AUTH_KEYS_DIR === undefined) delete process.env['HIVE_AUTH_KEYS_DIR'];
    else process.env['HIVE_AUTH_KEYS_DIR'] = originalEnv.HIVE_AUTH_KEYS_DIR;
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it('runs the full 11-step Criterio de Done end-to-end', async () => {
    // ── Step 2 + 3: migrate up + init ────────────────────────────────
    // `runInit` runs migrations internally + bootstraps the Hive.
    const credentialPath = path.join(workDir, 'admin.jwt');
    const initResult = await runInit({
      globals: makeGlobals(),
      adminEmail: 'leo@example.com',
      adminDisplayName: 'Leo',
      hiveName: 'Smoke Hive',
      db: `sqlite:${dbPath}`,
      keysDir,
      ttl: '365d',
      outputCredential: credentialPath,
    });
    expect(initResult.hiveId).toMatch(/^[0-9a-f-]{36}$/);
    expect(initResult.adminId).toMatch(/^[0-9a-f-]{36}$/);
    expect(initResult.signingKeyKid).toMatch(/^[0-9a-f]+$/);
    expect(initResult.credentialJti).toMatch(/^[0-9a-f-]{36}$/);
    expect(initResult.credentialPath).toBe(credentialPath);
    expect(initResult.credentialExpiresAt).toBeInstanceOf(Date);
    // AC-12: --output json is parseable.
    const initJson = formatOutput(initResult, { mode: 'json', schema: initSchema });
    expect(() => {
      JSON.parse(initJson);
    }).not.toThrow();
    // File perms 0600 (mask just the file mode bits).
    const stat = await fs.stat(credentialPath);
    expect(stat.mode & 0o777).toBe(0o600);

    // ── Build wire runtime for subsequent commands ─────────────────────
    let runtime: CliRuntime;
    try {
      runtime = await startCli({ logger: SILENT_LOGGER });
    } catch (err) {
      throw new Error(`startCli failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      // ── Step 4: hivekeeper create nico (with --emit-credential) ────
      const adminId = initResult.adminId;
      const nicoPath = path.join(workDir, 'nico.jwt');
      const nicoResult = await runCreateHivekeeper(runtime, {
        globals: makeGlobals(adminId),
        email: 'nico@example.com',
        displayName: 'Nico',
        admin: false,
        emitCredential: true,
        credentialTtl: '30d',
        outputCredential: nicoPath,
      });
      expect(nicoResult.hivekeeperId).toMatch(/^[0-9a-f-]{36}$/);
      expect(nicoResult.email).toBe('nico@example.com');
      expect(nicoResult.credentialJti).not.toBeNull();
      expect(nicoResult.credentialPath).toBe(nicoPath);
      const nicoStat = await fs.stat(nicoPath);
      expect(nicoStat.mode & 0o777).toBe(0o600);

      // Verify Cell exists for nico (cross-domain hook fired).
      const nicoCells = await runtime.db
        .selectFrom('cells')
        .select(['owner_id', 'owner_kind'])
        .where('owner_id', '=', nicoResult.hivekeeperId)
        .execute();
      expect(nicoCells).toHaveLength(1);
      expect(nicoCells[0]?.owner_kind).toBe('hivekeeper');

      // hive list-keepers shows admin + nico.
      const keepers = await runListKeepers(runtime, {
        globals: makeGlobals(adminId),
        activeOnly: true,
        limit: 100,
      });
      expect(keepers.keepers).toHaveLength(2);
      const emails = keepers.keepers.map((k) => k.email).sort();
      expect(emails).toEqual(['leo@example.com', 'nico@example.com']);

      // ── Step 5: agent create worker-a under leo, with credential ────
      const workerPath = path.join(workDir, 'worker-a.jwt');
      const workerResult = await runCreateAgent(runtime, {
        globals: makeGlobals(adminId),
        owner: 'leo@example.com',
        name: 'worker-a',
        type: 'worker',
        capabilities: ['ingest', 'parse'],
        instructions: 'Test worker',
        emitCredential: true,
        credentialTtl: '30d',
        outputCredential: workerPath,
      });
      expect(workerResult.agentId).toMatch(/^[0-9a-f-]{36}$/);
      expect(workerResult.name).toBe('worker-a');
      expect(workerResult.type).toBe('worker');
      expect(workerResult.ownerId).toBe(adminId);
      expect(workerResult.credentialJti).not.toBeNull();
      // AC-12: worker create JSON parseable.
      const workerJson = JSON.stringify(workerResult);
      expect(() => {
        JSON.parse(workerJson);
      }).not.toThrow();
      // Cell created cross-domain (PRY-002 hook).
      const workerCells = await runtime.db
        .selectFrom('cells')
        .select(['owner_id', 'owner_kind'])
        .where('owner_id', '=', workerResult.agentId)
        .execute();
      expect(workerCells).toHaveLength(1);
      expect(workerCells[0]?.owner_kind).toBe('agent');

      // ── Step 6: agent list --owner leo → 1 row ──────────────────────
      const agentList1 = await runListAgents(runtime, {
        globals: makeGlobals(adminId),
        owner: 'leo@example.com',
        type: undefined,
        state: undefined,
        limit: 100,
        cursor: undefined,
      });
      expect(agentList1.agents).toHaveLength(1);
      expect(agentList1.agents[0]?.name).toBe('worker-a');

      // ── Step 7: credential issue extra cred for worker-a ────────────
      const tempCredPath = path.join(workDir, 'worker-a-temp.jwt');
      const tempCred = await runIssueCredential(runtime, {
        globals: makeGlobals(adminId),
        participantRef: workerResult.agentId,
        ttl: '1h',
        reason: 'extra',
        outputCredential: tempCredPath,
      });
      expect(tempCred.jti).toMatch(/^[0-9a-f-]{36}$/);
      expect(tempCred.participantId).toBe(workerResult.agentId);

      const credList1 = await runListCredentials(runtime, {
        globals: makeGlobals(adminId),
        participantRef: workerResult.agentId,
        limit: 100,
      });
      expect(credList1.credentials).toHaveLength(2);
      expect(credList1.credentials.every((c) => !c.isRevoked)).toBe(true);

      // ── Step 8: credential rotate the original (workerResult cred) ──
      const rotatedPath = path.join(workDir, 'worker-a-rotated.jwt');
      const originalJti = workerResult.credentialJti as string;
      const rotated = await runRotateCredential(runtime, {
        globals: makeGlobals(adminId),
        jti: originalJti,
        ttl: '30d',
        outputCredential: rotatedPath,
      });
      expect(rotated.newJti).not.toBe(originalJti);
      expect(rotated.oldJti).toBe(originalJti);

      // Verify the original is now revoked.
      const credList2 = await runListCredentials(runtime, {
        globals: makeGlobals(adminId),
        participantRef: workerResult.agentId,
        limit: 100,
      });
      const originalAfterRotate = credList2.credentials.find((c) => c.jti === originalJti);
      expect(originalAfterRotate?.isRevoked).toBe(true);

      // ── Step 9: credential revoke the temp cred ────────────────────
      const revoked = await runRevokeCredential(runtime, {
        globals: makeGlobals(adminId),
        jti: tempCred.jti,
        reason: 'test cleanup',
      });
      expect(revoked.revokedJti).toBe(tempCred.jti);
      const credList3 = await runListCredentials(runtime, {
        globals: makeGlobals(adminId),
        participantRef: workerResult.agentId,
        limit: 100,
      });
      const tempAfterRevoke = credList3.credentials.find((c) => c.jti === tempCred.jti);
      expect(tempAfterRevoke?.isRevoked).toBe(true);

      // ── Step 10: audit query → 10+ events with expected categories ──
      const audit = await runAuditQuery(runtime, {
        globals: makeGlobals(adminId),
        categories: undefined,
        decision: undefined,
        actorId: undefined,
        subjectId: undefined,
        from: undefined,
        until: undefined,
        limit: 50,
      });
      expect(audit.entries.length).toBeGreaterThanOrEqual(5);
      const categories = new Set(audit.entries.map((e) => e.category));
      expect(categories).toContain('admin_hivekeeper_create');
      expect(categories).toContain('admin_credential_issue');
      expect(categories).toContain('admin_agent_create');
      expect(categories).toContain('admin_credential_rotate');
      expect(categories).toContain('admin_credential_revoke');
      // Ordering: occurred_at DESC.
      for (let i = 1; i < audit.entries.length; i++) {
        const prev = audit.entries[i - 1];
        const curr = audit.entries[i];
        if (prev && curr) {
          expect(prev.occurredAt.getTime()).toBeGreaterThanOrEqual(curr.occurredAt.getTime());
        }
      }

      // ── Step 11: agent revoke worker-a → cascade closes Cell ────────
      const revokedAgent = await runRevokeAgent(runtime, {
        globals: makeGlobals(adminId),
        agentRef: workerResult.agentId,
      });
      expect(revokedAgent.revokedAgentId).toBe(workerResult.agentId);

      // Cell should be closed.
      const closedCells = await runtime.db
        .selectFrom('cells')
        .select(['owner_id', 'state'])
        .where('owner_id', '=', workerResult.agentId)
        .execute();
      expect(closedCells).toHaveLength(1);
      expect(closedCells[0]?.state).toBe('closed');

      // Audit log now also has admin_agent_revoke.
      const auditAfter = await runAuditQuery(runtime, {
        globals: makeGlobals(adminId),
        categories: ['admin_agent_revoke'],
        decision: undefined,
        actorId: undefined,
        subjectId: undefined,
        from: undefined,
        until: undefined,
        limit: 5,
      });
      expect(auditAfter.entries.length).toBeGreaterThanOrEqual(1);
    } finally {
      await stopCli(runtime);
    }
  });

  it('AC-11: error path — credential revoke on missing jti returns EXIT_PRECONDITION', async () => {
    // Bootstrap so the wire can start.
    await runInit({
      globals: makeGlobals(),
      adminEmail: 'leo@example.com',
      adminDisplayName: 'Leo',
      hiveName: 'Smoke Hive',
      db: `sqlite:${dbPath}`,
      keysDir,
      ttl: '365d',
      outputCredential: undefined,
    });
    const runtime = await startCli({ logger: SILENT_LOGGER });
    try {
      const fakeJti = '019d57a0-d6e0-7b3a-8d4f-cb2c4e72d100';
      try {
        await runRevokeCredential(runtime, {
          globals: makeGlobals(),
          jti: fakeJti,
          reason: undefined,
        });
        expect.fail('should have thrown');
      } catch (err) {
        const mapped = mapErrorToExit(err);
        // INVALID_STATE_TRANSITION (credential_not_found subCode) → EXIT_PRECONDITION.
        expect(mapped.code).toBe(EXIT_PRECONDITION);
      }
    } finally {
      await stopCli(runtime);
    }
  });

  it('AC-11: error path — issue credential for non-existent participant returns EXIT_NOT_FOUND', async () => {
    await runInit({
      globals: makeGlobals(),
      adminEmail: 'leo@example.com',
      adminDisplayName: 'Leo',
      hiveName: 'Smoke Hive',
      db: `sqlite:${dbPath}`,
      keysDir,
      ttl: '365d',
      outputCredential: undefined,
    });
    const runtime = await startCli({ logger: SILENT_LOGGER });
    try {
      const fakeId = '019d57a0-d6e0-7b3a-8d4f-cb2c4e72d999';
      try {
        await runIssueCredential(runtime, {
          globals: makeGlobals(),
          participantRef: fakeId,
          ttl: '1h',
          reason: undefined,
          outputCredential: undefined,
        });
        expect.fail('should have thrown');
      } catch (err) {
        const mapped = mapErrorToExit(err);
        expect(mapped.code).toBe(EXIT_NOT_FOUND);
      }
    } finally {
      await stopCli(runtime);
    }
  });

  it('AC-11: error path — second init returns EXIT_PRECONDITION', async () => {
    await runInit({
      globals: makeGlobals(),
      adminEmail: 'leo@example.com',
      adminDisplayName: 'Leo',
      hiveName: 'Smoke Hive',
      db: `sqlite:${dbPath}`,
      keysDir,
      ttl: '365d',
      outputCredential: undefined,
    });
    try {
      await runInit({
        globals: makeGlobals(),
        adminEmail: 'leo2@example.com',
        adminDisplayName: 'Leo 2',
        hiveName: 'Smoke Hive 2',
        db: `sqlite:${dbPath}`,
        keysDir,
        ttl: '365d',
        outputCredential: undefined,
      });
      expect.fail('should have thrown');
    } catch (err) {
      const mapped = mapErrorToExit(err);
      expect(mapped.code).toBe(EXIT_PRECONDITION);
    }
  });

  it('AC-11: rejects malformed admin email with EXIT_USER_ERROR', async () => {
    try {
      await runInit({
        globals: makeGlobals(),
        adminEmail: 'not-an-email',
        adminDisplayName: undefined,
        hiveName: 'Smoke Hive',
        db: `sqlite:${dbPath}`,
        keysDir,
        ttl: '365d',
        outputCredential: undefined,
      });
      expect.fail('should have thrown');
    } catch (err) {
      const mapped = mapErrorToExit(err);
      expect(mapped.code).toBe(EXIT_USER_ERROR);
    }
  });

  it('PRY-040 — agent revoke accepts agent reference syntax end-to-end', async () => {
    // Initialise a hive whose name is suitable for the agent-reference suffix
    // (lowercase, single token — agent-references are `<name>@<owner-local>.<hive>`).
    await runInit({
      globals: makeGlobals(),
      adminEmail: 'leo@example.com',
      adminDisplayName: 'Leo',
      hiveName: 'test-hive',
      db: `sqlite:${dbPath}`,
      keysDir,
      ttl: '365d',
      outputCredential: undefined,
    });
    const runtime = await startCli({ logger: SILENT_LOGGER });
    try {
      // Create an agent owned by the bootstrap admin.
      const created = await runCreateAgent(runtime, {
        globals: makeGlobals('leo@example.com'),
        owner: 'leo@example.com',
        name: 'worker-friendly',
        type: 'worker',
        capabilities: [],
        instructions: 'Test worker for friendly-form revoke',
        emitCredential: false,
        credentialTtl: undefined,
        outputCredential: undefined,
      });
      expect(created.agentId).toMatch(/^[0-9a-f-]{36}$/);

      // Revoke via friendly reference — `<name>@<owner-local>.<hive>`.
      const revoked = await runRevokeAgent(runtime, {
        globals: makeGlobals('leo@example.com'),
        agentRef: 'worker-friendly@leo.test-hive',
      });
      expect(revoked.revokedAgentId).toBe(created.agentId);

      // Cell cascade-closes (matches the UUID path semantics).
      const closedCells = await runtime.db
        .selectFrom('cells')
        .select(['owner_id', 'state'])
        .where('owner_id', '=', created.agentId)
        .execute();
      expect(closedCells).toHaveLength(1);
      expect(closedCells[0]?.state).toBe('closed');

      // A non-existing friendly reference exits EXIT_NOT_FOUND
      // (PARTICIPANT_NOT_FOUND, agent_name_not_found). AuthError is sourced
      // from `@hive/server` (workspace package, single module identity), so
      // `mapErrorToExit` recognises it correctly across the dual-module dance
      // that the `#alias/*` imports field produces in vitest. The malformed-
      // input path also throws but its CliError suffers from dual-loading
      // (dist via alias vs src via relative); covered exhaustively by
      // `input/parse-reference.test.ts` unit tests instead.
      try {
        await runRevokeAgent(runtime, {
          globals: makeGlobals('leo@example.com'),
          agentRef: 'ghost@leo.test-hive',
        });
        expect.fail('should have thrown');
      } catch (err) {
        const mapped = mapErrorToExit(err);
        expect(mapped.code).toBe(EXIT_NOT_FOUND);
      }
    } finally {
      await stopCli(runtime);
    }
  });

  it('PRY-041 — credential rotate accepts <participant-ref>:latest end-to-end', async () => {
    // Initialise a hive whose name is suitable for friendly references
    // (lowercase, single token), same as the PRY-040 smoke. Bootstrap admin
    // gets a credential as part of `runInit`; we'll rotate it via the alias.
    const initResult = await runInit({
      globals: makeGlobals(),
      adminEmail: 'leo@example.com',
      adminDisplayName: 'Leo',
      hiveName: 'test-hive',
      db: `sqlite:${dbPath}`,
      keysDir,
      ttl: '365d',
      outputCredential: undefined,
    });
    const adminId = initResult.adminId;
    const adminCredentialJti = initResult.credentialJti;

    const runtime = await startCli({ logger: SILENT_LOGGER });
    try {
      // Rotate via friendly form `<email>:latest`. Should:
      //  1. Find the admin's currently-active credential (the one runInit
      //     emitted at bootstrap).
      //  2. Issue a new credential.
      //  3. Revoke the old one (now revoked_at is set).
      const rotated = await runRotateCredential(runtime, {
        globals: makeGlobals('leo@example.com'),
        jti: 'leo@example.com:latest',
        ttl: undefined,
        outputCredential: undefined,
      });
      expect(rotated.oldJti).toBe(adminCredentialJti);
      expect(rotated.newJti).not.toBe(adminCredentialJti);

      // Verify via `credential list` that the old JTI is now revoked and the
      // new JTI is the only active one.
      const listed = await runListCredentials(runtime, {
        globals: makeGlobals('leo@example.com'),
        participantRef: 'leo@example.com',
        limit: 10,
      });
      const newCred = listed.credentials.find((c) => c.jti === rotated.newJti);
      const oldCred = listed.credentials.find((c) => c.jti === adminCredentialJti);
      expect(newCred?.isRevoked).toBe(false);
      expect(oldCred?.isRevoked).toBe(true);

      // A second rotate via `:latest` resolves the *new* JTI (most-recent active).
      const rotatedTwice = await runRotateCredential(runtime, {
        globals: makeGlobals('leo@example.com'),
        jti: 'leo@example.com:latest',
        ttl: undefined,
        outputCredential: undefined,
      });
      expect(rotatedTwice.oldJti).toBe(rotated.newJti);

      // Once the admin's only active credential has been revoked manually, the
      // alias surfaces `no_active_credential` with EXIT_NOT_FOUND. We use
      // `revoke <jti>` (UUID path) on the current active to get into that
      // state, then attempt `:latest`.
      await runRevokeCredential(runtime, {
        globals: makeGlobals('leo@example.com'),
        jti: rotatedTwice.newJti,
        reason: 'smoke cleanup',
      });
      try {
        await runRotateCredential(runtime, {
          globals: makeGlobals('leo@example.com'),
          jti: 'leo@example.com:latest',
          ttl: undefined,
          outputCredential: undefined,
        });
        expect.fail('should have thrown — admin has no active credential');
      } catch (err) {
        const mapped = mapErrorToExit(err);
        expect(mapped.code).toBe(EXIT_NOT_FOUND);
      }

      // adminId still resolvable via DB to confirm the participant was never
      // touched (only the credentials).
      const adminRow = await runtime.db
        .selectFrom('hivekeepers')
        .select('state')
        .where('id', '=', adminId)
        .executeTakeFirst();
      expect(adminRow?.state).toBe('active');
    } finally {
      await stopCli(runtime);
    }
  });

  it('PRY-042 — audit query --actor-id <email> resolves the same actor as --actor-id <uuid>', async () => {
    const initResult = await runInit({
      globals: makeGlobals(),
      adminEmail: 'leo@example.com',
      adminDisplayName: 'Leo',
      hiveName: 'test-hive',
      db: `sqlite:${dbPath}`,
      keysDir,
      ttl: '365d',
      outputCredential: undefined,
    });
    const adminId = initResult.adminId;

    const runtime = await startCli({ logger: SILENT_LOGGER });
    try {
      // Generate at least one admin-attributed audit entry by creating a second
      // hivekeeper. `runInit` itself records bootstrap events but the actor
      // there is `system`, not the admin — we need an event with the admin as
      // actor for the friendly-id lookup to be observable.
      await runCreateHivekeeper(runtime, {
        globals: makeGlobals('leo@example.com'),
        email: 'second@example.com',
        displayName: 'Second',
        admin: false,
        emitCredential: false,
        credentialTtl: undefined,
        outputCredential: undefined,
      });

      // Query via the friendly form.
      const viaEmail = await runAuditQuery(runtime, {
        globals: makeGlobals('leo@example.com'),
        categories: undefined,
        decision: undefined,
        actorId: 'leo@example.com',
        subjectId: undefined,
        from: undefined,
        until: undefined,
        limit: 50,
      });

      // Query via the canonical UUID form.
      const viaUuid = await runAuditQuery(runtime, {
        globals: makeGlobals('leo@example.com'),
        categories: undefined,
        decision: undefined,
        actorId: adminId,
        subjectId: undefined,
        from: undefined,
        until: undefined,
        limit: 50,
      });

      // Both should return the same set of entries.
      expect(viaEmail.entries.length).toBeGreaterThanOrEqual(1);
      expect(viaEmail.entries.length).toBe(viaUuid.entries.length);
      const emailIds = viaEmail.entries.map((e) => e.id).sort();
      const uuidIds = viaUuid.entries.map((e) => e.id).sort();
      expect(emailIds).toStrictEqual(uuidIds);
      // Every returned entry must have actor_id === adminId.
      for (const entry of viaEmail.entries) {
        expect(entry.actorId).toBe(adminId);
      }

      // Friendly-id error path: unknown email surfaces EXIT_NOT_FOUND.
      try {
        await runAuditQuery(runtime, {
          globals: makeGlobals('leo@example.com'),
          categories: undefined,
          decision: undefined,
          actorId: 'ghost@example.com',
          subjectId: undefined,
          from: undefined,
          until: undefined,
          limit: 10,
        });
        expect.fail('expected unknown email to throw PARTICIPANT_NOT_FOUND');
      } catch (err) {
        expect(mapErrorToExit(err).code).toBe(EXIT_NOT_FOUND);
      }
    } finally {
      await stopCli(runtime);
    }
  });

  it('AC-12: --output json roundtrip is parseable for init + agent create', async () => {
    // Init returns InitCommandResult; serialize and re-parse.
    const result = await runInit({
      globals: makeGlobals(),
      adminEmail: 'leo@example.com',
      adminDisplayName: undefined,
      hiveName: 'Smoke Hive',
      db: `sqlite:${dbPath}`,
      keysDir,
      ttl: '365d',
      outputCredential: undefined,
    });
    const out = formatOutput(result, { mode: 'json', schema: initSchema });
    const parsed = JSON.parse(out) as { hiveId: string; adminId: string };
    expect(parsed.hiveId).toBe(result.hiveId);
    expect(parsed.adminId).toBe(result.adminId);
    // EXIT_OK is implicit — runInit returned without throwing.
    expect(EXIT_OK).toBe(0);
  });
});
