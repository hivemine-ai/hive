// `hivectl watch` in harness mode, in process, against a real Hive (SQLite over
// HTTP). The `--exec` child is a real process that dumps its environment and what
// it sees of the harness state file. Process-level behaviour (kill -9 and a
// relaunch) lives in run-harness.process.test.ts.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InMemoryTransport, Client } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EXIT_INTERRUPTED } from '#error/exit-codes.js';
import { startProxy } from '#session/proxy.js';
import type { RunningProxy } from '#session/proxy.js';
import {
  configRoot,
  projectKey,
  readPrivateJson,
  statePaths,
  writePrivateJson,
} from '#session/state-dir.js';
import { startHiveWorld } from '#session/test-hive.js';
import type { HiveWorld, HiveWorldOptions } from '#session/test-hive.js';
import { Upstream } from '#session/upstream.js';

import { runHarness } from './run-harness.js';
import type { HarnessIo, HarnessOverrides } from './run-harness.js';
import { resolveSessionWatchInput } from './session-input.js';
import type { HarnessInput } from './session-input.js';

const FAST = { minMs: 50, maxMs: 400, factor: 2, jitter: 0 };

let world: HiveWorld | undefined;
let scratch: string;
let configDir: string;
let projectDir: string;
let dumps: string;
const proxies: RunningProxy[] = [];
const runs: { controller: AbortController; done: Promise<number | string> }[] = [];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'hive-harness-'));
  chmodSync(scratch, 0o700);
  configDir = join(scratch, 'config');
  projectDir = join(scratch, 'project');
  dumps = join(scratch, 'dumps');
  mkdirSync(projectDir);
  mkdirSync(dumps);
});

afterEach(async () => {
  for (const proxy of proxies.splice(0)) await proxy.shutdown('test_end');
  for (const run of runs.splice(0)) {
    run.controller.abort();
    await run.done;
  }
  await world?.cleanup();
  world = undefined;
  rmSync(scratch, { recursive: true, force: true });
});

async function boot(options: HiveWorldOptions = {}): Promise<HiveWorld> {
  world = await startHiveWorld(options);
  writePrivateJson(statePaths(configDir).enrollment(projectKey(projectDir)), {
    projectPath: projectDir,
    serverUrl: world.url,
    credential: world.enrollmentCredential,
    hivectlPath: 'hivectl',
    installedAt: new Date().toISOString(),
  });
  return world;
}

/** A child that records its environment and the harness state file it was pointed at. */
const CHILD = `
const fs = require('fs');
const path = require('path');
let stdin = '';
process.stdin.on('data', (c) => (stdin += c)).on('end', () => {
  const marker = process.env.HIVE_HARNESS_SESSION;
  let state = null;
  try { state = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch {}
  const out = path.join(process.argv[1], Date.now() + '-' + process.pid + '.json');
  fs.writeFileSync(out, JSON.stringify({ env: process.env, stdin, state }));
});
`;

interface Dump {
  env: Record<string, string>;
  stdin: string;
  state: { token: string; serverUrl: string; agentId: string } | null;
}

function readDumps(): Dump[] {
  return readdirSync(dumps)
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dumps, f), 'utf8')) as Dump);
}

function harnessInput(extra: Record<string, unknown> = {}): HarnessInput {
  const input = resolveSessionWatchInput(
    {
      sessionName: 'nightly-worker',
      sessionDescription: 'Runs the nightly report',
      exec: process.execPath,
      execArgs: ['-e', CHILD, dumps],
      ...extra,
    },
    { HIVE_WATCH_AUTH_RETRY_MAX_SECONDS: '2' },
  );
  if (input.kind !== 'harness') throw new Error('not harness');
  return input;
}

function start(
  input: HarnessInput,
  env: NodeJS.ProcessEnv = {},
  overrides: HarnessOverrides = {},
): { controller: AbortController; done: Promise<number | string>; stderr: string[] } {
  const controller = new AbortController();
  const stderr: string[] = [];
  const io: HarnessIo = {
    stdout: () => undefined,
    stderr: (t) => stderr.push(t),
    env: { PATH: process.env['PATH'] ?? '', HIVE_CONFIG_DIR: configDir, ...env },
    signal: controller.signal,
    backoff: FAST,
    cwd: projectDir,
    home: scratch,
  };
  const done = runHarness(input, io, overrides).catch(
    (err: unknown) => (err as { code?: string }).code ?? String(err),
  );
  const run = { controller, done, stderr };
  runs.push(run);
  return run;
}

function harnessFiles(): string[] {
  const dir = join(configRoot({ HIVE_CONFIG_DIR: configDir }, '/x'), 'state', 'harness');
  return existsSync(dir) ? readdirSync(dir).map((f) => join(dir, f)) : [];
}

function stateOf(path: string): { token: string; agentId: string; expiresAt: string } {
  return readPrivateJson(path) as { token: string; agentId: string; expiresAt: string };
}

/** Registers another session and returns a client that can message the harness. */
async function sender(w: HiveWorld, name = 'docs-bot'): Promise<Client> {
  const upstream = new Upstream({ url: w.url, clientVersion: '0', probeTimeoutMs: 2_000 });
  await upstream.discover(w.enrollmentCredential);
  const reg = await upstream.registerSession(w.enrollmentCredential, {
    name,
    description: 'Sends messages',
  });
  if (!reg.ok) throw new Error(reg.message);
  return upstream.connect(() => reg.token);
}

async function send(client: Client, body = 'hello-body-text'): Promise<void> {
  const result = await client.callTool({
    name: 'send_message',
    arguments: { recipient: 'nightly-worker@leo.proxyhive', type: 'notification', body },
  });
  if (result.isError === true) throw new Error(JSON.stringify(result.content));
}

describe('watch harness mode', () => {
  it('registers once, writes the state file before the first child and keeps the session online', async () => {
    const w = await boot();
    const run = start(harnessInput());
    await expect.poll(() => harnessFiles().length, { timeout: 10_000 }).toBe(1);
    const statePath = harnessFiles()[0] ?? '';
    const state = stateOf(statePath);
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
    expect(statSync(join(statePath, '..')).mode & 0o777).toBe(0o700);
    expect(state).toMatchObject({ version: 1, serverUrl: w.url, watchPid: process.pid });
    expect(state.token).toMatch(/\S/);
    await expect.poll(() => w.isOnline(state.agentId), { timeout: 10_000 }).toBe(true);
    expect(await w.auditCount('agent_enrolled')).toBe(1);

    const client = await sender(w);
    await send(client);
    await expect.poll(() => readDumps().length, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
    const [first] = readDumps();
    expect(first?.env['HIVE_HARNESS_SESSION']).toBe(statePath);
    expect(first?.state?.token).toBe(state.token);
    expect(first?.stdin).not.toContain('hello-body-text');
    // The sender enrolled too; the harness never registered a second time.
    expect(await w.auditCount('agent_enrolled')).toBe(2);
    await client.close();

    run.controller.abort();
    expect(await run.done).toBe(EXIT_INTERRUPTED);
    expect(existsSync(statePath)).toBe(false);
    await expect.poll(() => w.isOnline(state.agentId)).toBe(false);
  }, 30_000);

  it('gives the child no HIVE_WATCH_* variable and no value holding the enrollment credential or a Worker token', async () => {
    const w = await boot();
    const enrollment = w.enrollmentCredential;
    const run = start(harnessInput(), {
      HIVE_WATCH_SERVER_URL: w.url,
      HIVE_WATCH_CREDENTIAL_FILE: '/somewhere',
      HIVE_WATCH_ANYTHING: 'x',
      SEEDED_COPY: enrollment,
      SEEDED_WRAPPED: `Bearer ${enrollment} trailing`,
      INNOCENT_NAME: `x${enrollment}`,
      HIVE_HARNESS_SESSION: '/inherited/marker',
      ANTHROPIC_API_KEY: 'sk-worker-own-key',
      PLAIN_SETTING: 'kept',
    });
    await expect.poll(() => harnessFiles().length, { timeout: 10_000 }).toBe(1);
    const statePath = harnessFiles()[0] ?? '';
    const token = stateOf(statePath).token;
    await expect.poll(() => w.isOnline(stateOf(statePath).agentId), { timeout: 10_000 }).toBe(true);
    const client = await sender(w);
    await send(client);
    await expect.poll(() => readDumps().length, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
    await client.close();

    const env = readDumps()[0]?.env ?? {};
    expect(Object.keys(env).filter((k) => k.startsWith('HIVE_WATCH_'))).toEqual([]);
    for (const [name, value] of Object.entries(env)) {
      expect({ name, leaks: value.includes(enrollment) || value.includes(token) }).toEqual({
        name,
        leaks: false,
      });
    }
    expect(env['HIVE_HARNESS_SESSION']).toBe(statePath);
    expect(env['ANTHROPIC_API_KEY']).toBe('sk-worker-own-key');
    expect(env['PLAIN_SETTING']).toBe('kept');
    expect(env['HIVE_MCP_CONFIG_FILE']).toBeUndefined();
    run.controller.abort();
    await run.done;
  }, 30_000);

  it('renews with a short TTL, rewrites the state file without cutting the stream, and a child on the old copy recovers with one retry', async () => {
    const w = await boot({ workerTokenTtlMs: 4_000 });
    const run = start(harnessInput(), {}, { renewFloorMs: 200 });
    await expect.poll(() => harnessFiles().length, { timeout: 10_000 }).toBe(1);
    const statePath = harnessFiles()[0] ?? '';
    const first = stateOf(statePath);
    await expect.poll(() => w.isOnline(first.agentId), { timeout: 10_000 }).toBe(true);

    // A harness child started now reads the first copy of the state file.
    const [clientSide, proxySide] = InMemoryTransport.createLinkedPair();
    const proxy = startProxy({
      env: { HIVE_CONFIG_DIR: configDir, HIVE_HARNESS_SESSION: statePath },
      cwd: projectDir,
      home: scratch,
      claudePid: 999_001,
      stderr: () => undefined,
      transport: proxySide,
      timings: { probeTimeoutMs: 2_000 },
    });
    proxies.push(proxy);
    const child = new Client({ name: 'harness-child', version: '0' });
    await child.connect(clientSide);
    const before = await child.callTool({ name: 'check_unread_messages', arguments: {} });
    expect(before.isError).not.toBe(true);

    // Two renewals: the first token is past its exp by then.
    await expect
      .poll(() => stateOf(statePath).token !== first.token, { timeout: 10_000 })
      .toBe(true);
    const second = stateOf(statePath).token;
    await expect.poll(() => stateOf(statePath).token !== second, { timeout: 10_000 }).toBe(true);
    await expect.poll(() => Date.now() > Date.parse(first.expiresAt) + 1_000).toBe(true);
    expect(w.isOnline(first.agentId)).toBe(true);
    expect(w.streamCount(first.agentId)).toBe(1);

    const after = await child.callTool({ name: 'check_unread_messages', arguments: {} });
    expect(after.isError).not.toBe(true);
    expect(await w.auditCount('agent_enrolled')).toBe(1);
    expect(await w.auditCount('agent_claimed')).toBe(0);
    await child.close();
    run.controller.abort();
    await run.done;
  }, 40_000);

  it('a relaunch with the same name renews with the persisted token (no agent_claimed)', async () => {
    const w = await boot();
    const firstRun = start(harnessInput());
    await expect.poll(() => harnessFiles().length, { timeout: 10_000 }).toBe(1);
    const agentId = stateOf(harnessFiles()[0] ?? '').agentId;
    await expect.poll(() => w.isOnline(agentId), { timeout: 10_000 }).toBe(true);
    firstRun.controller.abort();
    await firstRun.done;

    const second = start(harnessInput());
    await expect.poll(() => harnessFiles().length, { timeout: 10_000 }).toBe(1);
    expect(stateOf(harnessFiles()[0] ?? '').agentId).toBe(agentId);
    await expect.poll(() => w.isOnline(agentId), { timeout: 10_000 }).toBe(true);
    expect(await w.auditCount('agent_claimed')).toBe(0);
    expect(await w.auditCount('agent_enrolled')).toBe(1);
    second.controller.abort();
    await second.done;
  }, 30_000);

  it('a second watch with the same name in the same folder ends with WATCH_SESSION_NAME_IN_USE', async () => {
    const w = await boot();
    const first = start(harnessInput());
    await expect.poll(() => harnessFiles().length, { timeout: 10_000 }).toBe(1);
    const agentId = stateOf(harnessFiles()[0] ?? '').agentId;
    await expect.poll(() => w.isOnline(agentId), { timeout: 10_000 }).toBe(true);

    const second = start(harnessInput());
    expect(await second.done).toBe('WATCH_SESSION_NAME_IN_USE');
    expect(harnessFiles()).toHaveLength(1);
    expect(w.isOnline(agentId)).toBe(true);
    first.controller.abort();
    await first.done;
  }, 30_000);

  it('with --inline-mcp-config writes a 0600 MCP config declaring the proxy with the marker and points every child at it', async () => {
    const w = await boot();
    const run = start(
      harnessInput({ inlineMcpConfig: true }),
      {},
      {
        hivectl: { command: '/opt/hivectl/bin/node', args: ['/opt/hivectl/main.js'] },
      },
    );
    await expect
      .poll(() => harnessFiles().filter((f) => f.endsWith('.mcp.json')).length, {
        timeout: 10_000,
      })
      .toBe(1);
    const configPath = harnessFiles().find((f) => f.endsWith('.mcp.json')) ?? '';
    const statePath = harnessFiles().find((f) => !f.endsWith('.mcp.json')) ?? '';
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    expect(config).toEqual({
      mcpServers: {
        hive: {
          command: '/opt/hivectl/bin/node',
          args: ['/opt/hivectl/main.js', 'mcp', 'proxy'],
          env: { HIVE_HARNESS_SESSION: statePath },
        },
      },
    });
    expect(readFileSync(configPath, 'utf8')).not.toContain(stateOf(statePath).token);

    await expect.poll(() => w.isOnline(stateOf(statePath).agentId), { timeout: 10_000 }).toBe(true);
    const client = await sender(w);
    await send(client);
    await expect.poll(() => readDumps().length, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
    await client.close();
    expect(readDumps()[0]?.env['HIVE_MCP_CONFIG_FILE']).toBe(configPath);
    expect(readDumps()[0]?.env['HIVE_HARNESS_SESSION']).toBe(statePath);

    run.controller.abort();
    await run.done;
    expect(existsSync(configPath)).toBe(false);
  }, 30_000);

  it('fails with WATCH_STATE_FILE_INSECURE when the state file sits in a directory open to others', async () => {
    await boot();
    const open = join(scratch, 'open');
    mkdirSync(open, { mode: 0o755 });
    chmodSync(open, 0o755);
    const run = start(harnessInput({ stateFile: join(open, 'state.json') }));
    expect(await run.done).toBe('WATCH_STATE_FILE_INSECURE');
  }, 30_000);

  it('fails with WATCH_SESSION_REGISTER_REJECTED when Hive rejects the name', async () => {
    await boot();
    const run = start(harnessInput({ sessionName: 'Not A Valid Name!' }));
    expect(await run.done).toBe('WATCH_SESSION_REGISTER_REJECTED');
    expect(harnessFiles()).toHaveLength(0);
  }, 30_000);

  it('fails with WATCH_CREDENTIAL_MISSING without an enrollment for the folder or a credential file', async () => {
    world = await startHiveWorld();
    const run = start(harnessInput());
    expect(await run.done).toBe('WATCH_CREDENTIAL_MISSING');
  }, 30_000);

  it('uses --credential-file and --server instead of the folder enrollment', async () => {
    world = await startHiveWorld();
    // A raw JWT file, as `credential issue --enrollment` writes it.
    const credentialFile = join(scratch, 'enroll.jwt');
    writeFileSync(credentialFile, world.enrollmentCredential, { mode: 0o600 });
    const run = start(harnessInput({ server: world.url, credentialFile }));
    await expect.poll(() => harnessFiles().length, { timeout: 10_000 }).toBe(1);
    expect(stateOf(harnessFiles()[0] ?? '').token).toMatch(/\S/);
    run.controller.abort();
    expect(await run.done).toBe(EXIT_INTERRUPTED);
  }, 30_000);
});
