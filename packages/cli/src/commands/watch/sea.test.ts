// Opt-in smoke of `hivectl watch` inside the single-executable binary. It runs only
// when HIVECTL_SEA_BINARY points at a built binary (`pnpm --filter @hive/cli
// sea:build:<platform>`); the binary still needs `better-sqlite3` to be resolvable,
// for example through NODE_PATH, as in release.yml.

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startFakeHiveServer } from '@hive/client/testing';
import type { FakeHiveServer } from '@hive/client/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const binary = process.env['HIVECTL_SEA_BINARY'];
const TOKEN = 'sea-token';

let dir: string;
let credentialFile: string;
let server: FakeHiveServer;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hive-sea-'));
  chmodSync(dir, 0o700);
  credentialFile = join(dir, 'credential');
  writeFileSync(credentialFile, TOKEN, { mode: 0o600 });
  server = await startFakeHiveServer({ tokens: { [TOKEN]: 'agent-sea' }, replayOnListen: true });
  server.setUnread('agent-sea', { count: 2, senders: ['s1'] });
});

afterEach(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(binary === undefined)('hivectl watch inside the SEA binary', () => {
  it('--once prints one metadata line and exits 0', async () => {
    const child = spawn(
      binary as string,
      ['watch', '--once', '--server', server.url, '--credential-file', credentialFile],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    expect(code).toBe(0);
    expect(JSON.parse(out.trim())).toMatchObject({ senders: ['s1'], count: 2 });
  });

  it('watch prints the replayed event and stops on SIGINT with 130', async () => {
    const child = spawn(
      binary as string,
      ['watch', '--server', server.url, '--credential-file', credentialFile],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    const exited = new Promise<number | null>((resolve) => child.on('close', resolve));
    const end = Date.now() + 10_000;
    while (!out.includes('\n') && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    child.kill('SIGINT');
    expect(await exited).toBe(130);
    expect(JSON.parse(out.trim().split('\n')[0] ?? '')).toMatchObject({
      senders: ['s1'],
      count: 2,
    });
  });
});
