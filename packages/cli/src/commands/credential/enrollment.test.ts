// PRY-090 milestone 6: `hivectl credential issue --enrollment`, `rotate` and
// `revoke --revoke-agents` against a file SQLite Hive, with their `--output json`, exit
// codes and audit rows.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLogger, createVerifier, startCli, stopCli } from '@hive/server';
import type { CliRuntime } from '@hive/server';

import { runInit } from '#commands/init.js';
import { mapErrorToExit } from '#error/handler.js';
import { EXIT_NOT_FOUND, EXIT_USER_ERROR } from '#error/exit-codes.js';
import { formatOutput } from '#output/format.js';
import { issueEnrollmentCredentialSchema, revokeCredentialSchema } from '#output/schemas.js';
import type { GlobalCliOpts } from '#types.js';

import { runIssueEnrollmentCredential } from './issue-enrollment.js';
import type { IssueEnrollmentCredentialOpts } from './issue-enrollment.js';
import { runIssueCredential } from './issue.js';
import { runRevokeCredential } from './revoke.js';
import { runRotateCredential } from './rotate.js';

const SILENT_LOGGER = createLogger({ level: 'error' });
const GLOBALS: GlobalCliOpts = { output: 'json', yes: true, noColor: true, verbose: false };
const ENV_KEYS = ['HIVE_DB_URL', 'HIVE_AUTH_KEYS_DIR', 'HIVE_ENROLLMENT_MAX_AGENTS'] as const;

async function expectExit(promise: Promise<unknown>, code: number): Promise<void> {
  try {
    await promise;
  } catch (err) {
    expect(mapErrorToExit(err).code).toBe(code);
    return;
  }
  expect.fail(`expected exit code ${String(code)}`);
}

describe('hivectl credential --enrollment', () => {
  let workDir: string;
  let runtime: CliRuntime;
  let savedEnv: Record<string, string | undefined>;

  async function boot(env: Record<string, string> = {}): Promise<void> {
    Object.assign(process.env, env);
    runtime = await startCli({ logger: SILENT_LOGGER });
  }

  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hivectl-enrollment-'));
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    const dbPath = path.join(workDir, 'hive.sqlite');
    const keysDir = path.join(workDir, 'keys');
    process.env['HIVE_DB_URL'] = `sqlite:${dbPath}`;
    process.env['HIVE_AUTH_KEYS_DIR'] = keysDir;
    delete process.env['HIVE_ENROLLMENT_MAX_AGENTS'];
    await runInit({
      globals: GLOBALS,
      adminEmail: 'leo@example.com',
      adminDisplayName: 'Leo',
      hiveName: 'enroll-hive',
      db: `sqlite:${dbPath}`,
      keysDir,
      ttl: '365d',
      outputCredential: path.join(workDir, 'admin.jwt'),
    });
  });

  afterEach(async () => {
    await stopCli(runtime);
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    await fs.rm(workDir, { recursive: true, force: true });
  });

  function issueOpts(overrides: Partial<IssueEnrollmentCredentialOpts> = {}) {
    return {
      globals: GLOBALS,
      ownerRef: 'leo@example.com',
      namePrefix: 'ci-',
      maxAgents: '3',
      ttl: undefined,
      reason: 'ci runners',
      outputCredential: path.join(workDir, 'enroll.jwt'),
      ...overrides,
    };
  }

  async function auditRows(category: string) {
    return runtime.db
      .selectFrom('audit_log')
      .select(['subject_id', 'subject_kind', 'reason_code', 'detail', 'actor_kind'])
      .where('category', '=', category as 'admin_agent_revoke')
      .execute();
  }

  async function registerAgent(enrollmentJwt: string, name: string): Promise<string> {
    const verifier = createVerifier({
      signingKeys: runtime.signingKeys,
      blocklist: runtime.blocklist,
      participantsRepo: runtime.participantsRepo,
      hiveStableIdentifier: runtime.hiveStableIdentifier,
    });
    const identity = await verifier.verify(`Bearer ${enrollmentJwt}`);
    const { agent } = await runtime.enrollment.createEnrolledAgent(
      {
        ownerId: identity.participantId,
        name,
        description: 'ci runner',
        enrolledVia: identity.snapshot.credentialJti,
      },
      identity,
    );
    return agent.id;
  }

  it('issue --enrollment writes the JWT to a 0600 file, prints JSON without it and audits the event', async () => {
    await boot();
    const result = await runIssueEnrollmentCredential(runtime, issueOpts());

    const credentialPath = path.join(workDir, 'enroll.jwt');
    expect((await fs.stat(credentialPath)).mode & 0o777).toBe(0o600);
    const jwt = await fs.readFile(credentialPath, 'utf8');
    const json = JSON.parse(
      formatOutput(result, { mode: 'json', schema: issueEnrollmentCredentialSchema }),
    ) as Record<string, unknown>;
    expect(json).toMatchObject({
      jti: result.jti,
      scope: 'enroll',
      namePrefix: 'ci-',
      maxAgents: 3,
      credentialPath,
    });
    expect(JSON.stringify(json)).not.toContain(jwt);
    expect(json['nextStep']).toContain('hivectl claude install');

    const row = await runtime.db
      .selectFrom('credentials')
      .select('scope')
      .where('jti', '=', result.jti)
      .executeTakeFirstOrThrow();
    expect(row.scope).toBe('enroll');
    const [audit] = await auditRows('enrollment_credential_issued');
    expect(audit?.subject_id).toBe(result.jti);
    expect(audit?.subject_kind).toBe('credential');
    expect(JSON.parse(audit?.detail ?? '{}')).toMatchObject({
      ownerId: result.ownerId,
      name_prefix: 'ci-',
      max_agents: 3,
      reason: 'ci runners',
    });
  });

  it('issue --enrollment rejects user errors with EXIT_USER_ERROR and an unknown owner with EXIT_NOT_FOUND', async () => {
    await boot();
    await expectExit(
      runIssueEnrollmentCredential(runtime, issueOpts({ outputCredential: undefined })),
      EXIT_USER_ERROR,
    );
    for (const maxAgents of ['11', '0', 'two']) {
      await expectExit(
        runIssueEnrollmentCredential(runtime, issueOpts({ maxAgents })),
        EXIT_USER_ERROR,
      );
    }
    await expectExit(
      runIssueEnrollmentCredential(runtime, issueOpts({ namePrefix: 'CI_' })),
      EXIT_USER_ERROR,
    );
    await expectExit(
      runIssueEnrollmentCredential(runtime, issueOpts({ ownerRef: 'nobody@example.com' })),
      EXIT_NOT_FOUND,
    );
    expect(await auditRows('enrollment_credential_issued')).toHaveLength(0);
  });

  it('reads HIVE_ENROLLMENT_MAX_AGENTS from the environment', async () => {
    await boot({ HIVE_ENROLLMENT_MAX_AGENTS: '2' });
    await expectExit(
      runIssueEnrollmentCredential(runtime, issueOpts({ maxAgents: '3' })),
      EXIT_USER_ERROR,
    );
    await runIssueEnrollmentCredential(runtime, issueOpts({ maxAgents: '2' }));
  });

  it('rotate keeps the enrollment claims, requires --output-credential and audits enrollment_credential_rotated', async () => {
    await boot();
    const issued = await runIssueEnrollmentCredential(runtime, issueOpts());
    await expectExit(
      runRotateCredential(runtime, {
        globals: GLOBALS,
        jti: issued.jti,
        ttl: undefined,
        outputCredential: undefined,
      }),
      EXIT_USER_ERROR,
    );

    const rotatedPath = path.join(workDir, 'enroll-2.jwt');
    const rotated = await runRotateCredential(runtime, {
      globals: GLOBALS,
      jti: issued.jti,
      ttl: undefined,
      outputCredential: rotatedPath,
    });
    expect(rotated.credentialJwt).toBeUndefined();
    const row = await runtime.db
      .selectFrom('credentials')
      .select('snapshot')
      .where('jti', '=', rotated.newJti)
      .executeTakeFirstOrThrow();
    expect(JSON.parse(row.snapshot)).toMatchObject({
      scope: 'enroll',
      name_prefix: 'ci-',
      max_agents: 3,
    });
    const [audit] = await auditRows('enrollment_credential_rotated');
    expect(audit?.subject_id).toBe(issued.jti);
    expect(JSON.parse(audit?.detail ?? '{}')).toMatchObject({ newJti: rotated.newJti });
    expect(await auditRows('admin_credential_rotate')).toHaveLength(0);
  });

  it('revoke --revoke-agents revokes the enrollment, its Worker tokens and its Agents, with one admin_agent_revoke each', async () => {
    await boot();
    const issued = await runIssueEnrollmentCredential(runtime, issueOpts());
    const jwt = await fs.readFile(path.join(workDir, 'enroll.jwt'), 'utf8');
    const agentA = await registerAgent(jwt, 'ci-a');
    const agentB = await registerAgent(jwt, 'ci-b');

    const result = await runRevokeCredential(runtime, {
      globals: GLOBALS,
      jti: issued.jti,
      reason: 'leaked',
      revokeAgents: true,
    });

    expect(result.revokedTokens).toBe(2);
    expect(new Set(result.revokedAgentIds)).toEqual(new Set([agentA, agentB]));
    expect(
      JSON.parse(formatOutput(result, { mode: 'json', schema: revokeCredentialSchema })),
    ).toMatchObject({ revokedJti: issued.jti, revokedTokens: 2 });
    const states = await runtime.db
      .selectFrom('agents')
      .select('state')
      .where('id', 'in', [agentA, agentB])
      .execute();
    expect(states.map((s) => s.state)).toEqual(['revoked', 'revoked']);

    const [revokedEvent] = await auditRows('enrollment_credential_revoked');
    expect(revokedEvent?.subject_id).toBe(issued.jti);
    expect(JSON.parse(revokedEvent?.detail ?? '{}')).toMatchObject({
      revokedAgents: true,
      revokedTokens: 2,
      reason: 'leaked',
    });
    const agentEvents = await auditRows('admin_agent_revoke');
    expect(new Set(agentEvents.map((e) => e.subject_id))).toEqual(new Set([agentA, agentB]));
    expect(agentEvents.every((e) => e.reason_code === 'enrollment_credential_revoked')).toBe(true);
    expect(await auditRows('admin_credential_revoke')).toHaveLength(0);
  });

  it('revoke without --revoke-agents keeps the Agents and still blocklists their tokens', async () => {
    await boot();
    const issued = await runIssueEnrollmentCredential(runtime, issueOpts());
    const jwt = await fs.readFile(path.join(workDir, 'enroll.jwt'), 'utf8');
    const agentId = await registerAgent(jwt, 'ci-a');

    const result = await runRevokeCredential(runtime, {
      globals: GLOBALS,
      jti: issued.jti,
      reason: undefined,
    });

    expect(result).toEqual({ revokedJti: issued.jti, revokedTokens: 1, revokedAgentIds: [] });
    const row = await runtime.db
      .selectFrom('agents')
      .select('state')
      .where('id', '=', agentId)
      .executeTakeFirstOrThrow();
    expect(row.state).toBe('active');
    expect(await auditRows('admin_agent_revoke')).toHaveLength(0);
  });

  it('revoke --revoke-agents on a full credential is EXIT_USER_ERROR and revokes nothing', async () => {
    await boot();
    const full = await runIssueCredential(runtime, {
      globals: GLOBALS,
      participantRef: 'leo@example.com',
      ttl: undefined,
      reason: undefined,
      outputCredential: undefined,
    });
    await expectExit(
      runRevokeCredential(runtime, {
        globals: GLOBALS,
        jti: full.jti,
        reason: undefined,
        revokeAgents: true,
      }),
      EXIT_USER_ERROR,
    );
    expect(await runtime.blocklist.contains(full.jti)).toBe(false);
  });
});
