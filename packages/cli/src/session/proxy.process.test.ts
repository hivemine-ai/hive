// `hivectl mcp proxy` as a real process (the compiled CLI; requires `pnpm build`)
// spoken to over stdio by a real MCP client, against a real Hive. The test process
// plays `claude`: it is the parent of every proxy, so the PID-map fixtures use its
// own PID and start time.

import type { ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { processStartTime } from './pid-map.js';
import { projectKey, statePaths, writePrivateJson } from './state-dir.js';
import { startHiveWorld } from './test-hive.js';
import type { HiveWorld } from './test-hive.js';

const CLI_ENTRY = fileURLToPath(new URL('../../dist/main.js', import.meta.url));

let world: HiveWorld;
let scratch: string;
let configDir: string;
let projectDir: string;
const running: { client: Client; transport: StdioClientTransport }[] = [];

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'hive-proxy-proc-'));
  chmodSync(scratch, 0o700);
  configDir = join(scratch, 'config');
  projectDir = join(scratch, 'project');
  writePrivateJson(join(projectDir, '.keep'), {});
  world = await startHiveWorld({ listenLeaseMs: 60_000 });
  writePrivateJson(statePaths(configDir).enrollment(projectKey(projectDir)), {
    projectPath: projectDir,
    serverUrl: world.url,
    credential: world.enrollmentCredential,
    hivectlPath: CLI_ENTRY,
    installedAt: new Date().toISOString(),
  });
});

afterEach(async () => {
  for (const { client } of running.splice(0)) await client.close().catch(() => undefined);
  await world.cleanup();
  rmSync(scratch, { recursive: true, force: true });
});

function writePidMap(entry: { name?: string; description?: string; startTime?: string }): void {
  writePrivateJson(statePaths(configDir).pidMap(process.pid), {
    claudePid: process.pid,
    claudeStartTime: entry.startTime ?? processStartTime(process.pid),
    sessionId: 'session-1',
    source: 'resume',
    ...(entry.name !== undefined && { name: entry.name }),
    ...(entry.description !== undefined && { description: entry.description }),
  });
}

interface Proxy {
  client: Client;
  transport: StdioClientTransport;
  pid: number;
  stderr: string[];
}

async function launch(): Promise<Proxy> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI_ENTRY, 'mcp', 'proxy'],
    cwd: projectDir,
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: scratch,
      HIVE_CONFIG_DIR: configDir,
      CLAUDE_PROJECT_DIR: projectDir,
      HIVE_PROXY_LOG_LEVEL: 'info',
    },
    stderr: 'pipe',
  });
  const stderr: string[] = [];
  transport.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));
  const client = new Client({ name: 'fake-claude-code', version: '0' });
  await client.connect(transport);
  running.push({ client, transport });
  return { client, transport, pid: transport.pid as number, stderr };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function names(proxy: Proxy): Promise<string[]> {
  return (await proxy.client.listTools()).tools.map((t) => t.name);
}

async function status(proxy: Proxy): Promise<Record<string, unknown>> {
  const result = await proxy.client.callTool({ name: 'session_status', arguments: {} });
  return result.structuredContent as Record<string, unknown>;
}

async function registerAs(proxy: Proxy, name: string): Promise<CallToolResult> {
  return await proxy.client.callTool({
    name: 'register_session',
    arguments: { name, description: 'Works on the API' },
  });
}

function agentIdOf(result: CallToolResult): string {
  return (result.structuredContent as { agent_id: string }).agent_id;
}

const proxyEntry = () => statePaths(configDir).proxy(process.pid);

describe('hivectl mcp proxy (process)', () => {
  it('publishes its proxies/ entry keyed by the PID of its parent', async () => {
    const proxy = await launch();
    await expect.poll(() => existsSync(proxyEntry())).toBe(true);
    expect(await names(proxy)).toEqual(['register_session', 'session_status']);
  }, 30_000);

  it('registers by itself from a PID-map entry of its parent with a name, before any tool call', async () => {
    writePidMap({ name: 'claude-api', description: 'Resumed session' });
    const proxy = await launch();

    await expect
      .poll(async () => (await status(proxy))['registered'], { timeout: 10_000 })
      .toBe(true);
    expect((await status(proxy))['name']).toBe('claude-api');
    expect(await names(proxy)).toContain('send_message');
  }, 30_000);

  it('ignores a PID-map entry whose start time does not match its parent', async () => {
    writePidMap({
      name: 'claude-api',
      description: 'Resumed session',
      startTime: 'Mon Jan  1 00:00:00 2001',
    });
    const proxy = await launch();

    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect((await status(proxy))['registered']).toBe(false);
    expect(await names(proxy)).toEqual(['register_session', 'session_status']);
  }, 30_000);

  it('after kill -9, a relaunch with the same name renews with the persisted token instead of claiming', async () => {
    const first = await launch();
    const agentId = agentIdOf(await registerAs(first, 'claude-api'));
    await expect.poll(() => world.isOnline(agentId)).toBe(true);
    expect(await world.auditCount('agent_enrolled')).toBe(1);

    process.kill(first.pid, 'SIGKILL');
    await expect.poll(() => isAlive(first.pid)).toBe(false);
    writePidMap({ name: 'claude-api' });
    const second = await launch();

    await expect
      .poll(async () => (await status(second))['registered'], { timeout: 10_000 })
      .toBe(true);
    expect(await world.auditCount('agent_claimed')).toBe(0);
    expect(await world.auditCount('agent_enrolled')).toBe(1);
    expect(second.stderr.join('')).toContain('"via":"renewed"');
  }, 30_000);

  it('a second process with the same name in the same folder, while the first lives, gets name_in_use', async () => {
    const first = await launch();
    const agentId = agentIdOf(await registerAs(first, 'claude-api'));
    await expect.poll(() => world.isOnline(agentId)).toBe(true);
    const second = await launch();

    const rejected = await registerAs(second, 'claude-api');

    expect(rejected.isError).toBe(true);
    expect((rejected.structuredContent as { error: { code: string } }).error.code).toBe(
      'name_in_use',
    );
    expect((await status(first))['registered']).toBe(true);
    expect(world.isOnline(agentId)).toBe(true);
  }, 30_000);

  it('reads the PID map again on tools/list while unregistered (hook written after the proxy started)', async () => {
    const proxy = await launch();
    expect(await names(proxy)).toEqual(['register_session', 'session_status']);
    writePidMap({ name: 'late-hook', description: 'Hook ran late' });

    await expect
      .poll(async () => (await names(proxy)).includes('send_message'), { timeout: 10_000 })
      .toBe(true);
    expect((await status(proxy))['name']).toBe('late-hook');
  }, 30_000);

  it('does not exit while Hive is down: it degrades into session_status and registers once Hive is back', async () => {
    await world.stop();
    const proxy = await launch();

    const failed = await registerAs(proxy, 'claude-api');
    expect(failed.isError).toBe(true);
    expect(isAlive(proxy.pid)).toBe(true);
    expect((await status(proxy))['last_error']).toMatchObject({ code: 'transport' });

    await world.start();
    const registered = await registerAs(proxy, 'claude-api');
    expect(registered.isError).not.toBe(true);
    expect(isAlive(proxy.pid)).toBe(true);
  }, 30_000);

  for (const end of ['stdin EOF', 'SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    it(`${end} closes the stream at once (offline before the lease), removes its entry and exits`, async () => {
      const proxy = await launch();
      const agentId = agentIdOf(await registerAs(proxy, 'claude-api'));
      await expect.poll(() => world.isOnline(agentId)).toBe(true);
      expect(existsSync(proxyEntry())).toBe(true);

      if (end === 'stdin EOF') {
        // The SDK keeps the child private; ending its stdin is exactly what Claude Code's exit does.
        (proxy.transport as unknown as { _process?: ChildProcess })._process?.stdin?.end();
      } else {
        process.kill(proxy.pid, end);
      }

      await expect.poll(() => isAlive(proxy.pid), { timeout: 5_000 }).toBe(false);
      expect(world.isOnline(agentId)).toBe(false);
      expect(existsSync(proxyEntry())).toBe(false);
      const reason = end === 'stdin EOF' ? 'client_closed' : end;
      expect(proxy.stderr.join('')).toContain(`"event":"proxy.shutdown","reason":"${reason}"`);
    }, 30_000);
  }
});
