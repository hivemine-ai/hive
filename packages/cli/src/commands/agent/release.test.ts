// PRY-094: `hivectl agent release` and `hivectl agent list` with origin and retired Agents
// (ADR-026), against a file SQLite Hive, with exit codes, `--output json` and audit rows.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLogger, createVerifier, startCli, stopCli } from '@hive/server';
import type { CliRuntime, UUIDv7 } from '@hive/server';

import { runInit } from '#commands/init.js';
import { mapErrorToExit } from '#error/handler.js';
import {
  EXIT_NOT_FOUND,
  EXIT_PERMISSION,
  EXIT_PRECONDITION,
  EXIT_USER_ERROR,
} from '#error/exit-codes.js';
import { formatOutput, formatOutputList } from '#output/format.js';
import { listAgentsSchema, releaseAgentSchema } from '#output/schemas.js';
import type { GlobalCliOpts } from '#types.js';

import { runListAgents } from './list.js';
import { runReleaseAgent } from './release.js';

const SILENT_LOGGER = createLogger({ level: 'error' });
const GLOBALS: GlobalCliOpts = { output: 'json', yes: true, noColor: true, verbose: false };
const ENV_KEYS = ['HIVE_DB_URL', 'HIVE_AUTH_KEYS_DIR'] as const;
const OWNER_EMAIL = 'leo@example.com';

async function exitOf(promise: Promise<unknown>): Promise<{ code: number; message: string }> {
  try {
    await promise;
  } catch (err) {
    return mapErrorToExit(err);
  }
  return expect.fail('expected the command to fail');
}

describe('hivectl agent release and agent list (ADR-026)', () => {
  let workDir: string;
  let runtime: CliRuntime;
  let savedEnv: Record<string, string | undefined>;
  let ownerId: UUIDv7;
  let enrollmentJwt: string;

  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hivectl-release-'));
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    const dbPath = path.join(workDir, 'hive.sqlite');
    const keysDir = path.join(workDir, 'keys');
    process.env['HIVE_DB_URL'] = `sqlite:${dbPath}`;
    process.env['HIVE_AUTH_KEYS_DIR'] = keysDir;
    const init = await runInit({
      globals: GLOBALS,
      adminEmail: OWNER_EMAIL,
      adminDisplayName: 'Leo',
      hiveName: 'release-hive',
      db: `sqlite:${dbPath}`,
      keysDir,
      ttl: '365d',
      outputCredential: path.join(workDir, 'admin.jwt'),
    });
    ownerId = init.adminId;
    runtime = await startCli({ logger: SILENT_LOGGER });
    const enrollment = await runtime.enrollment.issueEnrollmentCredential(
      { ownerId },
      { kind: 'system' },
    );
    enrollmentJwt = enrollment.jwt;
  });

  afterEach(async () => {
    await stopCli(runtime);
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    await fs.rm(workDir, { recursive: true, force: true });
  });

  async function registerAgent(name: string): Promise<{ agentId: UUIDv7; tokenJti: UUIDv7 }> {
    const verifier = createVerifier({
      signingKeys: runtime.signingKeys,
      blocklist: runtime.blocklist,
      participantsRepo: runtime.participantsRepo,
      hiveStableIdentifier: runtime.hiveStableIdentifier,
    });
    const identity = await verifier.verify(`Bearer ${enrollmentJwt}`);
    const { agent, token } = await runtime.enrollment.createEnrolledAgent(
      {
        ownerId: identity.participantId,
        name,
        description: 'ci runner',
        enrolledVia: identity.snapshot.credentialJti,
      },
      identity,
    );
    return { agentId: agent.id, tokenJti: token.jti };
  }

  async function otherAdmin(): Promise<UUIDv7> {
    const hk = await runtime.participantsWriteRepo.createHivekeeper(
      {
        hiveId: runtime.hiveStableIdentifier,
        colonyId: runtime.hiveColonyId,
        email: 'other@example.com',
        isAdmin: true,
      },
      { kind: 'system' },
    );
    return hk.id;
  }

  function release(agentRef: string, operatorId: string | undefined, yes = true) {
    const globals: GlobalCliOpts = { ...GLOBALS, yes };
    if (operatorId !== undefined) globals.operatorId = operatorId;
    return runReleaseAgent(runtime, { globals, agentRef });
  }

  async function auditRows() {
    return runtime.db
      .selectFrom('audit_log')
      .selectAll()
      .where('category', '=', 'admin_agent_release')
      .execute();
  }

  describe('agent release', () => {
    it('refuses without --operator-id: EXIT_PERMISSION release_owner_only, nothing revoked', async () => {
      const { agentId, tokenJti } = await registerAgent('ci-docs');

      const exit = await exitOf(release(agentId, undefined));

      expect(exit.code).toBe(EXIT_PERMISSION);
      expect(exit.message).toContain('release_owner_only');
      expect(await runtime.blocklist.contains(tokenJti)).toBe(false);
      expect(await auditRows()).toEqual([]);
    });

    it('refuses an admin who is not the owner: EXIT_PERMISSION release_owner_only', async () => {
      const { agentId, tokenJti } = await registerAgent('ci-docs');

      const exit = await exitOf(release(agentId, await otherAdmin()));

      expect(exit.code).toBe(EXIT_PERMISSION);
      expect(exit.message).toContain('release_owner_only');
      expect(await runtime.blocklist.contains(tokenJti)).toBe(false);
    });

    it('with the owner (by email), revokes every holder token, blocks the renewal and audits admin_agent_release', async () => {
      const { agentId, tokenJti } = await registerAgent('ci-docs');

      const result = await release('ci-docs@leo.release-hive', OWNER_EMAIL);

      expect(result).toMatchObject({ agentId, revokedHolderTokens: 1 });
      expect(result.message).toContain('60');
      expect(await runtime.blocklist.contains(tokenJti)).toBe(true);
      const revocation = await runtime.db
        .selectFrom('credential_revocations')
        .select(['reason', 'revoked_by'])
        .where('jti', '=', tokenJti)
        .executeTakeFirstOrThrow();
      expect(revocation).toEqual({ reason: 'agent_release', revoked_by: ownerId });
      const agent = await runtime.participantsRepo.findAgentById(agentId);
      expect(agent).toMatchObject({ state: 'active', lastWorkerJti: null });
      await expect(
        runtime.enrollment.renewWorkerToken({ agentId, presentedJti: tokenJti }),
      ).rejects.toMatchObject({ code: 'CREDENTIAL_INAUTHENTIC' });

      const rows = await auditRows();
      expect(rows.map((r) => [r.actor_id, r.actor_kind, r.subject_id, r.subject_kind])).toEqual([
        [ownerId, 'hivekeeper', agentId, 'participant'],
      ]);
      expect(JSON.parse(rows[0]?.detail as string)).toMatchObject({ revokedHolderTokens: 1 });
      expect(
        JSON.parse(formatOutput(result, { mode: 'json', schema: releaseAgentSchema })),
      ).toEqual({ agentId, revokedHolderTokens: 1, message: result.message });
    });

    it('is idempotent: without tokens in the window it succeeds with "no active holder"', async () => {
      const { agentId } = await registerAgent('ci-docs');
      await release(agentId, ownerId);

      const again = await release(agentId, ownerId);

      expect(again).toMatchObject({ agentId, revokedHolderTokens: 0 });
      expect(again.message).toContain('no active holder');
    });

    it('requires --yes', async () => {
      const { agentId } = await registerAgent('ci-docs');

      const exit = await exitOf(release(agentId, ownerId, false));

      expect(exit.code).toBe(EXIT_USER_ERROR);
      expect(exit.message).toContain('requires_yes');
    });

    it('answers EXIT_NOT_FOUND for an unknown Agent and EXIT_PRECONDITION for a manual or revoked one', async () => {
      expect((await exitOf(release('nobody@leo.release-hive', ownerId))).code).toBe(EXIT_NOT_FOUND);
      expect((await exitOf(release('01900000-0000-7000-8000-000000000099', ownerId))).code).toBe(
        EXIT_NOT_FOUND,
      );

      const manual = await runtime.participantsWriteRepo.createAgent(
        {
          hiveId: runtime.hiveStableIdentifier,
          colonyId: runtime.hiveColonyId,
          ownerId,
          name: 'manual-bot',
          type: 'worker',
        },
        { kind: 'system' },
      );
      const manualExit = await exitOf(release(manual.id, ownerId));
      expect(manualExit.code).toBe(EXIT_PRECONDITION);
      expect(manualExit.message).toContain('release_requires_enrollment_agent');

      const { agentId } = await registerAgent('ci-docs');
      await runtime.participantsWriteRepo.revokeAgent(agentId, { kind: 'system' });
      const revokedExit = await exitOf(release(agentId, ownerId));
      expect(revokedExit.code).toBe(EXIT_PRECONDITION);
      expect(revokedExit.message).toContain('agent_revoked');
    });
  });

  describe('agent list', () => {
    it('always shows retired Agents, with origin and enrolledVia, and --state retired filters', async () => {
      const { agentId: retired } = await registerAgent('ci-retired');
      await registerAgent('ci-active');
      await runtime.db
        .updateTable('agents')
        .set({ state: 'retired', retired_at: new Date().toISOString() })
        .where('id', '=', retired)
        .execute();

      const all = await runListAgents(runtime, {
        globals: GLOBALS,
        owner: undefined,
        type: undefined,
        state: undefined,
        limit: undefined,
        cursor: undefined,
      });

      const row = all.agents.find((a) => a.id === retired);
      expect(row).toMatchObject({
        state: 'retired',
        origin: 'enrollment',
        enrolledVia: expect.any(String) as unknown,
        lastConnectedAt: expect.any(Date) as unknown,
      });
      const json = JSON.parse(
        formatOutputList(all.agents, { mode: 'json', schema: listAgentsSchema }),
      ) as { id: string; origin: string; state: string; enrolledVia: string | null }[];
      expect(json.find((a) => a.id === retired)).toMatchObject({
        origin: 'enrollment',
        state: 'retired',
      });
      const table = formatOutputList(all.agents, { mode: 'table', schema: listAgentsSchema });
      expect(table).toContain('origin');
      expect(table).toContain('retired');

      const onlyRetired = await runListAgents(runtime, {
        globals: GLOBALS,
        owner: undefined,
        type: undefined,
        state: 'retired',
        limit: undefined,
        cursor: undefined,
      });
      expect(onlyRetired.agents.map((a) => a.id)).toEqual([retired]);
    });

    it('shows origin manual and no enrolledVia for a manual Agent', async () => {
      const manual = await runtime.participantsWriteRepo.createAgent(
        {
          hiveId: runtime.hiveStableIdentifier,
          colonyId: runtime.hiveColonyId,
          ownerId,
          name: 'manual-bot',
          type: 'worker',
        },
        { kind: 'system' },
      );

      const all = await runListAgents(runtime, {
        globals: GLOBALS,
        owner: undefined,
        type: undefined,
        state: undefined,
        limit: undefined,
        cursor: undefined,
      });

      expect(all.agents.find((a) => a.id === manual.id)).toMatchObject({
        origin: 'manual',
        enrolledVia: null,
      });
    });
  });
});
