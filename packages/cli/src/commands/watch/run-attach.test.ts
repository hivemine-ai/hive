// `hivectl watch --attach-session`, in process, against a real proxy (in process,
// its real local socket) and a real Hive (SQLite over HTTP).

import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EXIT_INTERRUPTED, EXIT_OK } from '#error/exit-codes.js';
import { startProxy } from '#session/proxy.js';
import type { RunningProxy } from '#session/proxy.js';
import { projectKey, statePaths, writePrivateJson } from '#session/state-dir.js';
import { startHiveWorld } from '#session/test-hive.js';
import type { HiveWorld } from '#session/test-hive.js';
import { Upstream } from '#session/upstream.js';

import { parseChannelLine, runAttach } from './run-attach.js';
import type { AttachIo } from './run-attach.js';
import type { AttachInput } from './session-input.js';

const CLAUDE_PID = 778_001;
const START = 'start-of-claude';
const FAST = { minMs: 30, maxMs: 200, factor: 2, jitter: 0 };

let world: HiveWorld;
let scratch: string;
let configDir: string;
let projectDir: string;
const proxies: RunningProxy[] = [];
const clients: Client[] = [];
const runs: { controller: AbortController; done: Promise<number | string> }[] = [];

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'hive-attach-'));
  chmodSync(scratch, 0o700);
  configDir = join(scratch, 'config');
  projectDir = join(scratch, 'project');
  mkdirSync(projectDir);
  world = await startHiveWorld();
  writePrivateJson(statePaths(configDir).enrollment(projectKey(projectDir)), {
    projectPath: projectDir,
    serverUrl: world.url,
    credential: world.enrollmentCredential,
    hivectlPath: 'hivectl',
    installedAt: new Date().toISOString(),
  });
});

afterEach(async () => {
  for (const run of runs.splice(0)) {
    run.controller.abort();
    await run.done;
  }
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const proxy of proxies.splice(0)) await proxy.shutdown('test_end');
  await world.cleanup();
  rmSync(scratch, { recursive: true, force: true });
});

function writePidMap(sessionId: string, name?: string): void {
  writePrivateJson(statePaths(configDir).pidMap(CLAUDE_PID), {
    claudePid: CLAUDE_PID,
    claudeStartTime: START,
    sessionId,
    source: name === undefined ? 'startup' : 'resume',
    ...(name !== undefined && { name, description: 'Works on the API' }),
  });
}

async function openProxy(): Promise<{ proxy: RunningProxy; client: Client }> {
  const [clientSide, proxySide] = InMemoryTransport.createLinkedPair();
  const proxy = startProxy({
    env: { HIVE_CONFIG_DIR: configDir, CLAUDE_PROJECT_DIR: projectDir },
    cwd: projectDir,
    home: scratch,
    claudePid: CLAUDE_PID,
    startTimeOf: () => START,
    stderr: () => undefined,
    transport: proxySide,
    timings: { backoff: FAST, probeTimeoutMs: 2_000, silenceTimeoutMs: 5_000 },
  });
  proxies.push(proxy);
  const client = new Client({ name: 'fake-claude-code', version: '0' });
  await client.connect(clientSide);
  clients.push(client);
  return { proxy, client };
}

async function register(client: Client, name = 'claude-api'): Promise<void> {
  const result = await client.callTool({
    name: 'register_session',
    arguments: { name, description: 'Works on the API' },
  });
  expect(result.isError).not.toBe(true);
}

async function sender(): Promise<Client> {
  const upstream = new Upstream({ url: world.url, clientVersion: '0', probeTimeoutMs: 2_000 });
  await upstream.discover(world.enrollmentCredential);
  const reg = await upstream.registerSession(world.enrollmentCredential, {
    name: 'docs-bot',
    description: 'Sends messages',
  });
  if (!reg.ok) throw new Error(reg.message);
  const client = await upstream.connect(() => reg.token);
  clients.push(client);
  return client;
}

async function send(client: Client, body = 'attach-secret-body'): Promise<void> {
  const result = await client.callTool({
    name: 'send_message',
    arguments: { recipient: 'claude-api@leo.proxyhive', type: 'notification', body },
  });
  expect(result.isError).not.toBe(true);
}

function attach(
  sessionId: string,
  extra: Partial<AttachInput> = {},
): { stdout: string[]; controller: AbortController; done: Promise<number | string> } {
  const controller = new AbortController();
  const stdout: string[] = [];
  const io: AttachIo = {
    stdout: (t) => stdout.push(t),
    stderr: () => undefined,
    env: { HIVE_CONFIG_DIR: configDir },
    signal: controller.signal,
    backoff: FAST,
    cwd: projectDir,
    home: scratch,
  };
  const input: AttachInput = {
    kind: 'attach',
    sessionId,
    once: false,
    attachTimeoutMs: 10_000,
    ...extra,
  };
  const done = runAttach(input, io, { startTimeOf: () => START }).catch(
    (err: unknown) => (err as { code?: string }).code ?? String(err),
  );
  const run = { stdout, controller, done };
  runs.push(run);
  return run;
}

const lines = (stdout: string[]): Record<string, unknown>[] =>
  stdout
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe('watch --attach-session', () => {
  it('started before the registration, waits and emits metadata lines once the proxy registers', async () => {
    const run = attach('session-1');
    await new Promise((r) => setTimeout(r, 300));
    writePidMap('session-1');
    const { client } = await openProxy();
    await new Promise((r) => setTimeout(r, 300));
    expect(run.stdout).toEqual([]);

    await register(client);
    const from = await sender();
    // The listener attaches after the registration; keep sending until a line lands.
    await expect
      .poll(
        async () => {
          await send(from);
          return lines(run.stdout).length;
        },
        { timeout: 15_000, interval: 500 },
      )
      .toBeGreaterThanOrEqual(1);
    const [line] = lines(run.stdout);
    expect(Object.keys(line ?? {}).sort()).toEqual(['count', 'eventId', 'senders']);
    expect(run.stdout.join('')).not.toContain('attach-secret-body');

    run.controller.abort();
    expect(await run.done).toBe(EXIT_INTERRUPTED);
  }, 40_000);

  it('re-resolves the channel when the proxy is replaced (reconnected by hand) and keeps emitting', async () => {
    writePidMap('session-1');
    const first = await openProxy();
    await register(first.client);
    writePidMap('session-1', 'claude-api');
    const run = attach('session-1');
    const from = await sender();
    await expect
      .poll(
        async () => {
          await send(from);
          return lines(run.stdout).length;
        },
        { timeout: 15_000, interval: 500 },
      )
      .toBeGreaterThanOrEqual(1);

    await first.proxy.shutdown('reconnect');
    const seen = lines(run.stdout).length;
    // The new proxy registers by itself from the PID map, with another handle.
    await openProxy();
    await expect
      .poll(
        async () => {
          await send(from);
          return lines(run.stdout).length;
        },
        { timeout: 20_000, interval: 500 },
      )
      .toBeGreaterThan(seen);
    expect(await Promise.race([run.done, Promise.resolve('running')])).toBe('running');
  }, 60_000);

  it('a second listener of the same session does not end: it takes over when the first goes', async () => {
    writePidMap('session-1', 'claude-api');
    await openProxy();
    const first = attach('session-1');
    await new Promise((r) => setTimeout(r, 800));
    const second = attach('session-1');
    await new Promise((r) => setTimeout(r, 800));
    first.controller.abort();
    await first.done;
    const from = await sender();
    await expect
      .poll(
        async () => {
          await send(from);
          return lines(second.stdout).length;
        },
        { timeout: 15_000, interval: 500 },
      )
      .toBeGreaterThanOrEqual(1);
  }, 40_000);

  it('--once prints one line when something is unread and nothing otherwise', async () => {
    writePidMap('session-1');
    const { client } = await openProxy();
    await register(client);
    const empty = attach('session-1', { once: true });
    expect(await empty.done).toBe(EXIT_OK);
    expect(empty.stdout).toEqual([]);

    await send(await sender());
    await expect
      .poll(
        async () => {
          const run = attach('session-1', { once: true });
          await run.done;
          return lines(run.stdout);
        },
        { timeout: 10_000 },
      )
      .toEqual([expect.objectContaining({ count: 1 })]);
  }, 40_000);

  it('--once without a registered proxy ends with WATCH_ONCE_FAILED', async () => {
    writePidMap('session-1');
    await openProxy();
    const run = attach('session-1', { once: true });
    expect(await run.done).toBe('WATCH_ONCE_FAILED');
  }, 20_000);

  it('an unknown session id ends with WATCH_ATTACH_TARGET_NOT_FOUND after the wait', async () => {
    writePidMap('session-1');
    const run = attach('another-session', { attachTimeoutMs: 600 });
    expect(await run.done).toBe('WATCH_ATTACH_TARGET_NOT_FOUND');
  }, 20_000);

  it('ignores a PID-map entry whose start time does not match (reused PID)', async () => {
    writePrivateJson(statePaths(configDir).pidMap(CLAUDE_PID), {
      claudePid: CLAUDE_PID,
      claudeStartTime: 'another-process',
      sessionId: 'session-1',
      source: 'startup',
    });
    const run = attach('session-1', { attachTimeoutMs: 600 });
    expect(await run.done).toBe('WATCH_ATTACH_TARGET_NOT_FOUND');
  }, 20_000);
});

describe('parseChannelLine', () => {
  it('keeps only valid metadata lines', () => {
    expect(parseChannelLine('{"eventId":"e1","senders":["s"],"count":2,"extra":1}')).toEqual({
      eventId: 'e1',
      senders: ['s'],
      count: 2,
    });
    expect(parseChannelLine('{"error":"listener_busy"}')).toBeNull();
    expect(parseChannelLine('{"eventId":"e1","senders":["s"],"count":0}')).toBeNull();
    expect(parseChannelLine('{"eventId":"e\\u0007","senders":[],"count":1}')).toBeNull();
    expect(parseChannelLine('not json')).toBeNull();
  });
});
