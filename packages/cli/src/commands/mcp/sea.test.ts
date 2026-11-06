// Opt-in smoke of `hivectl mcp proxy` inside the single-executable binary, like
// commands/watch/sea.test.ts. It runs only when HIVECTL_SEA_BINARY points at a built
// binary; better-sqlite3 must be resolvable next to it (the CI job links it). It
// proves the bundled MCP SDK serves stdio and that the native lock module loads:
// a registration attempt takes the token lock of the name and releases it.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { projectKey, statePaths, writePrivateJson } from '#session/state-dir.js';
import { tryExclusiveLock } from '#session/token-lock.js';

const binary = process.env['HIVECTL_SEA_BINARY'];

let dir: string;
let config: string;
let project: string;
let client: Client | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hive-sea-proxy-'));
  chmodSync(dir, 0o700);
  config = join(dir, 'config');
  project = join(dir, 'project');
  mkdirSync(project);
  // Nothing listens on port 1: the registration fails as a transport error after
  // the lock of the name was taken.
  writePrivateJson(statePaths(config).enrollment(projectKey(project)), {
    projectPath: project,
    serverUrl: 'http://127.0.0.1:1/mcp',
    credential: 'header.eyJzY29wZSI6ImVucm9sbCJ9.sig',
    hivectlPath: binary ?? '',
    installedAt: new Date().toISOString(),
  });
});

afterEach(async () => {
  await client?.close().catch(() => undefined);
  client = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(binary === undefined)('hivectl mcp proxy inside the SEA binary', () => {
  it('serves the two local tools over stdio and takes and releases the token lock', async () => {
    const transport = new StdioClientTransport({
      command: binary as string,
      args: ['mcp', 'proxy'],
      cwd: project,
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: dir,
        HIVE_CONFIG_DIR: config,
        CLAUDE_PROJECT_DIR: project,
      },
      stderr: 'pipe',
    });
    client = new Client({ name: 'sea-smoke', version: '0' });
    await client.connect(transport);

    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(['register_session', 'session_status']);

    const result = await client.callTool({
      name: 'register_session',
      arguments: { name: 'sea-bot', description: 'SEA smoke' },
    });
    expect(result.isError).toBe(true);
    expect((result.structuredContent as { error: { code: string } }).error.code).toBe('transport');

    const lock = statePaths(config).tokenLock(projectKey(project), 'sea-bot');
    expect(existsSync(lock)).toBe(true);
    expect(statSync(lock).mode & 0o777).toBe(0o600);
    const taken = tryExclusiveLock(lock);
    expect(taken).toBeDefined();
    taken?.release();
  }, 30_000);
});
