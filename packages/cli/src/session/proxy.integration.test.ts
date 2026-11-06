// The proxy in process, between a real MCP client on the downstream side (what
// Claude Code would be) and a real Hive over HTTP (SQLite, SDK 2026-07-28). The
// process-level behaviour (signals, stdin EOF, kill -9, a second process) lives
// in proxy.process.test.ts.

import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startProxy } from './proxy.js';
import type { ProxyConfig, RunningProxy, SessionStatus } from './proxy.js';
import { configRoot, projectKey, statePaths, writePrivateJson } from './state-dir.js';
import { parsePersistedToken } from './token-store.js';
import { readPrivateJson } from './state-dir.js';
import { startHiveWorld } from './test-hive.js';
import type { HiveWorld, HiveWorldOptions } from './test-hive.js';

const HIVE_TOOLS = [
  'get_agent_config',
  'send_message',
  'reply_to',
  'read_mailbox',
  'mark_read',
  'check_unread_messages',
  'list_agents',
  'get_agent_status',
];
const FAST_BACKOFF = { minMs: 50, maxMs: 500, factor: 2, jitter: 0 };
const CLAUDE_PID = 777_001;

let world: HiveWorld | undefined;
let scratch: string;
let configDir: string;
let projectDir: string;
const proxies: RunningProxy[] = [];
const clients: Client[] = [];

async function bootWorld(options: HiveWorldOptions = {}): Promise<HiveWorld> {
  world = await startHiveWorld(options);
  return world;
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'hive-proxy-it-'));
  chmodSync(scratch, 0o700);
  configDir = join(scratch, 'config');
  projectDir = join(scratch, 'project');
  writePrivateJson(join(projectDir, '.keep'), {});
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const proxy of proxies.splice(0)) await proxy.shutdown('test_end');
  await world?.cleanup();
  world = undefined;
  rmSync(scratch, { recursive: true, force: true });
});

function install(w: HiveWorld): void {
  const paths = statePaths(configRoot({ HIVE_CONFIG_DIR: configDir }, '/nowhere'));
  writePrivateJson(paths.enrollment(projectKey(projectDir)), {
    projectPath: projectDir,
    serverUrl: w.url,
    credential: w.enrollmentCredential,
    hivectlPath: 'hivectl',
    installedAt: new Date().toISOString(),
  });
}

interface Session {
  proxy: RunningProxy;
  client: Client;
  listChanged: number[];
  stderr: string[];
}

async function openSession(
  overrides: Partial<ProxyConfig> = {},
  mode: 'legacy' | 'modern' = 'legacy',
): Promise<Session> {
  const [clientSide, proxySide] = InMemoryTransport.createLinkedPair();
  const stderr: string[] = [];
  const proxy = startProxy({
    env: {
      HIVE_CONFIG_DIR: configDir,
      CLAUDE_PROJECT_DIR: projectDir,
      HIVE_PROXY_LOG_LEVEL: 'debug',
    },
    cwd: projectDir,
    home: scratch,
    claudePid: CLAUDE_PID,
    startTimeOf: () => 'start-of-claude',
    stderr: (line) => stderr.push(line),
    transport: proxySide,
    timings: { backoff: FAST_BACKOFF, silenceTimeoutMs: 5_000, probeTimeoutMs: 2_000 },
    ...overrides,
  });
  proxies.push(proxy);
  const client = new Client(
    { name: 'fake-claude-code', version: '0' },
    mode === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
  );
  const listChanged: number[] = [];
  client.setNotificationHandler('notifications/tools/list_changed', () => {
    listChanged.push(Date.now());
  });
  await client.connect(clientSide);
  if (mode === 'modern') {
    await client.listen({ toolsListChanged: true });
  }
  clients.push(client);
  return { proxy, client, listChanged, stderr };
}

function structured<T>(result: CallToolResult): T {
  return result.structuredContent as T;
}

async function status(session: Session): Promise<SessionStatus> {
  return structured<SessionStatus>(
    await session.client.callTool({ name: 'session_status', arguments: {} }),
  );
}

async function toolNames(session: Session): Promise<string[]> {
  return (await session.client.listTools()).tools.map((t) => t.name).sort();
}

async function registerAs(session: Session, name = 'claude-api'): Promise<CallToolResult> {
  return await session.client.callTool({
    name: 'register_session',
    arguments: { name, description: 'Works on the API' },
  });
}

function persistedToken(name = 'claude-api'): string | undefined {
  const paths = statePaths(configDir);
  return parsePersistedToken(readPrivateJson(paths.tokenFile(projectKey(projectDir), name)))?.token;
}

describe('mcp proxy against a real Hive', () => {
  it('before registration lists only register_session and session_status; after it emits list_changed and passes the Hive catalog through', async () => {
    const w = await bootWorld();
    install(w);
    const session = await openSession();

    expect(await toolNames(session)).toEqual(['register_session', 'session_status']);
    expect(await status(session)).toMatchObject({
      registered: false,
      name: null,
      mode: 'interactive',
    });

    const result = await registerAs(session);
    expect(result.isError).not.toBe(true);
    const registered = structured<{ agent_ref: string; agent_id: string }>(result);
    expect(registered.agent_ref).toBe('claude-api@leo.proxyhive');
    await expect.poll(() => session.listChanged.length).toBeGreaterThanOrEqual(1);

    const names = await toolNames(session);
    expect(names).toEqual([...HIVE_TOOLS, 'register_session', 'session_status'].sort());
    expect(names.filter((n) => n === 'register_session')).toHaveLength(1);

    const config = await session.client.callTool({
      name: 'get_agent_config',
      arguments: {},
    });
    expect(config.isError).not.toBe(true);
    expect(JSON.stringify(config.structuredContent)).toContain(registered.agent_id);
  }, 30_000);

  it('session_status reports registered, name, agent reference, Hive, project, mode and last error, never the token', async () => {
    const w = await bootWorld();
    install(w);
    const session = await openSession();
    await registerAs(session);

    const current = await status(session);
    expect(current).toEqual({
      registered: true,
      name: 'claude-api',
      agent_ref: 'claude-api@leo.proxyhive',
      hive: w.url,
      project: projectDir,
      mode: 'interactive',
      last_error: null,
    });
    const token = persistedToken();
    expect(token).toBeTruthy();
    expect(JSON.stringify(current)).not.toContain(token as string);
    expect(JSON.stringify(current)).not.toContain(w.enrollmentCredential);
    expect(session.stderr.join('')).not.toContain(token as string);
    expect(session.stderr.join('')).not.toContain(w.enrollmentCredential);
  }, 30_000);

  it('holds the listen stream: online after registering, offline at once on shutdown', async () => {
    const w = await bootWorld({ listenLeaseMs: 60_000 });
    install(w);
    const session = await openSession();
    const registered = structured<{ agent_id: string }>(await registerAs(session));

    await expect.poll(() => w.isOnline(registered.agent_id)).toBe(true);
    await session.proxy.shutdown('test');
    await expect.poll(() => w.isOnline(registered.agent_id), { timeout: 2_000 }).toBe(false);
  }, 30_000);

  it('renews before expiry with a short TTL, rewrites the token file, keeps one stream and stays online', async () => {
    const w = await bootWorld({ workerTokenTtlMs: 3_000 });
    install(w);
    const session = await openSession({ timings: { backoff: FAST_BACKOFF, renewFloorMs: 200 } });
    const registered = structured<{ agent_id: string }>(await registerAs(session));
    const first = persistedToken();
    await expect.poll(() => w.isOnline(registered.agent_id)).toBe(true);

    await expect.poll(() => persistedToken() !== first, { timeout: 5_000 }).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 3_500));

    expect(w.isOnline(registered.agent_id)).toBe(true);
    expect(w.streamCount(registered.agent_id)).toBe(1);
    const call = await session.client.callTool({
      name: 'check_unread_messages',
      arguments: {},
    });
    expect(call.isError).not.toBe(true);
    expect((await status(session)).registered).toBe(true);
  }, 30_000);

  it('survives the server going away and comes back online when it returns', async () => {
    const w = await bootWorld();
    install(w);
    const session = await openSession();
    const registered = structured<{ agent_id: string }>(await registerAs(session));
    await expect.poll(() => w.isOnline(registered.agent_id)).toBe(true);

    await w.stop();
    const down = await session.client
      .callTool({
        name: 'check_unread_messages',
        arguments: {},
      })
      .catch((err: unknown) => err);
    expect(down).toBeDefined();
    await w.start();

    await expect.poll(() => w.isOnline(registered.agent_id), { timeout: 10_000 }).toBe(true);
    expect((await status(session)).registered).toBe(true);
  }, 30_000);

  it('another name in the same process leaves the previous identity (offline) and registers the new one', async () => {
    const w = await bootWorld();
    install(w);
    const session = await openSession();
    const first = structured<{ agent_id: string }>(await registerAs(session, 'claude-api'));
    await expect.poll(() => w.isOnline(first.agent_id)).toBe(true);

    const second = structured<{ agent_id: string }>(await registerAs(session, 'docs-bot'));

    await expect.poll(() => w.isOnline(second.agent_id)).toBe(true);
    expect(w.isOnline(first.agent_id)).toBe(false);
    expect((await status(session)).name).toBe('docs-bot');
  }, 30_000);

  it('a second session of the same folder cannot take the name while the first holds it: name_in_use', async () => {
    const w = await bootWorld();
    install(w);
    const first = await openSession();
    const firstRegistered = structured<{ agent_id: string }>(await registerAs(first));
    await expect.poll(() => w.isOnline(firstRegistered.agent_id)).toBe(true);
    const second = await openSession({ claudePid: CLAUDE_PID + 1 });

    const rejected = await registerAs(second);

    expect(rejected.isError).toBe(true);
    expect(structured<{ error: { code: string } }>(rejected).error.code).toBe('name_in_use');
    expect((await status(second)).last_error?.code).toBe('name_in_use');
    expect((await status(first)).registered).toBe(true);
  }, 30_000);

  it('answers -32001 on a normal request by renewing and retrying once', async () => {
    const w = await bootWorld();
    install(w);
    let rejectNext = false;
    let registerCalls = 0;
    const session = await openSession({
      fetch: async (input, init) => {
        const body = typeof init?.body === 'string' ? init.body : '';
        if (body.includes('"register_session"')) registerCalls += 1;
        if (rejectNext && body.includes('"get_agent_config"')) {
          rejectNext = false;
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: (JSON.parse(body) as { id: unknown }).id,
              error: { code: -32001, message: 'unauthorized' },
            }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          );
        }
        return fetch(input, init);
      },
    });
    await registerAs(session);
    const before = registerCalls;
    rejectNext = true;

    const result = await session.client.callTool({
      name: 'get_agent_config',
      arguments: {},
    });

    expect(result.isError).not.toBe(true);
    expect(registerCalls - before).toBe(1);
    expect((await status(session)).registered).toBe(true);
  }, 30_000);

  it('cuts the upstream request when Claude Code sends notifications/cancelled', async () => {
    const w = await bootWorld();
    install(w);
    let upstreamAborted: Promise<boolean> | undefined;
    const session = await openSession({
      fetch: (input, init) => {
        const body = typeof init?.body === 'string' ? init.body : '';
        if (body.includes('"list_agents"')) {
          const signal = init?.signal;
          upstreamAborted = new Promise((resolve) => {
            signal?.addEventListener('abort', () => resolve(true), { once: true });
          });
          return new Promise<Response>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        }
        return fetch(input, init);
      },
    });
    await registerAs(session);
    const controller = new AbortController();

    const pending = session.client
      .callTool({ name: 'list_agents', arguments: {} }, { signal: controller.signal })
      .catch((err: unknown) => err);
    await expect.poll(() => upstreamAborted !== undefined).toBe(true);
    controller.abort();

    expect(await upstreamAborted).toBe(true);
    await pending;
  }, 30_000);

  it('shuts down within its deadline even when the upstream hangs, cleaning local state first', async () => {
    const w = await bootWorld();
    install(w);
    let discovers = 0;
    const session = await openSession({
      claudePid: process.pid,
      startTimeOf: () => 'start-of-claude',
      timings: { backoff: FAST_BACKOFF, shutdownTimeoutMs: 500 },
      fetch: (input, init) => {
        const body = typeof init?.body === 'string' ? init.body : '';
        // After the two start-up discovers (probe + discover), every probe of the stream hangs and ignores aborts.
        if (body.includes('"server/discover"') && (discovers += 1) > 2) {
          return new Promise<Response>(() => undefined);
        }
        return fetch(input, init);
      },
    });
    await expect.poll(() => discovers).toBeGreaterThanOrEqual(2);
    await registerAs(session);
    await expect.poll(() => discovers).toBeGreaterThanOrEqual(3);
    const entry = statePaths(configDir).proxy(process.pid);
    expect(existsSync(entry)).toBe(true);

    const started = Date.now();
    await session.proxy.shutdown('test');

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(existsSync(entry)).toBe(false);
  }, 30_000);

  it('detects a server that does not expose resource subscriptions and reports it in session_status', async () => {
    const w = await bootWorld();
    install(w);
    const session = await openSession({
      fetch: async (input, init) => {
        const res = await fetch(input, init);
        const body = typeof init?.body === 'string' ? init.body : '';
        if (!body.includes('"server/discover"')) return res;
        const json = (await res.json()) as { result?: { capabilities?: Record<string, unknown> } };
        delete json.result?.capabilities?.['resources'];
        return new Response(JSON.stringify(json), {
          status: res.status,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    await expect
      .poll(async () => (await status(session)).last_error?.code, { timeout: 5_000 })
      .toBe('server_mismatch');
    const rejected = await registerAs(session);
    expect(rejected.isError).toBe(true);
  }, 30_000);

  it('serves a modern (2026-07-28) client too, with list_changed over its own listen stream', async () => {
    const w = await bootWorld();
    install(w);
    const session = await openSession({}, 'modern');

    expect(await toolNames(session)).toEqual(['register_session', 'session_status']);
    await registerAs(session);

    await expect.poll(() => session.listChanged.length).toBeGreaterThanOrEqual(1);
    expect(await toolNames(session)).toContain('send_message');
  }, 30_000);

  it('without an enrollment for the folder exposes the local tools and reports not_installed', async () => {
    await bootWorld();
    const session = await openSession();

    expect(await toolNames(session)).toEqual(['register_session', 'session_status']);
    expect((await status(session)).last_error?.code).toBe('not_installed');
    const rejected = await registerAs(session);
    expect(structured<{ error: { code: string } }>(rejected).error.code).toBe('not_installed');
  }, 30_000);
});
