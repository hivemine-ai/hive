import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startFakeHiveServer } from '@hive/client/testing';
import type { FakeHiveServer } from '@hive/client/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildProgram } from '#program.js';

const TOKEN = 'cli-token-xyz';
let dir: string;
let credentialFile: string;
let server: FakeHiveServer;
let out: string[];
let err: string[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hive-cmd-'));
  chmodSync(dir, 0o700);
  credentialFile = join(dir, 'credential');
  writeFileSync(credentialFile, TOKEN, { mode: 0o600 });
  server = await startFakeHiveServer({ tokens: { [TOKEN]: 'agent-1' } });
  out = [];
  err = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
    out.push(String(c));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
    err.push(String(c));
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

async function run(args: string[]): Promise<number> {
  const { program, getExitCode } = buildProgram();
  await program.parseAsync(['node', 'hivectl', 'watch', ...args]);
  return getExitCode();
}

describe('hivectl watch command wiring', () => {
  it('--once prints one line and exits 0', async () => {
    server.setUnread('agent-1', { count: 2, senders: ['s1'] });
    const code = await run(['--once', '--server', server.url, '--credential-file', credentialFile]);
    expect(code).toBe(0);
    expect(JSON.parse(out.join('').trim())).toMatchObject({ senders: ['s1'], count: 2 });
  });

  it('--once with --exec exits 1 with WATCH_ONCE_EXEC_CONFLICT', async () => {
    const code = await run([
      '--once',
      '--exec',
      'x',
      '--server',
      server.url,
      '--credential-file',
      credentialFile,
    ]);
    expect(code).toBe(1);
    expect(err.join('')).toContain('WATCH_ONCE_EXEC_CONFLICT');
  });

  it('exits 1 with WATCH_SERVER_URL_MISSING when no server is configured', async () => {
    delete process.env['HIVE_WATCH_SERVER_URL'];
    const code = await run(['--once', '--credential-file', credentialFile]);
    expect(code).toBe(1);
    expect(err.join('')).toContain('WATCH_SERVER_URL_MISSING');
  });

  it('exits 4 with WATCH_CREDENTIAL_REJECTED for a rejected credential under --once', async () => {
    server.setRejectAuth(true);
    const code = await run(['--once', '--server', server.url, '--credential-file', credentialFile]);
    expect(code).toBe(4);
    expect(err.join('')).toContain('WATCH_CREDENTIAL_REJECTED');
    expect(out.join('')).toBe('');
  });

  it('exits 4 with WATCH_CREDENTIAL_INSECURE_PERMS for an open credential file', async () => {
    chmodSync(credentialFile, 0o644);
    const code = await run(['--once', '--server', server.url, '--credential-file', credentialFile]);
    expect(code).toBe(4);
    expect(err.join('')).toContain('WATCH_CREDENTIAL_INSECURE_PERMS');
  });

  it('exits 1 with WATCH_CREDENTIAL_MISSING when the file is absent', async () => {
    const code = await run([
      '--once',
      '--server',
      server.url,
      '--credential-file',
      join(dir, 'absent'),
    ]);
    expect(code).toBe(1);
    expect(err.join('')).toContain('WATCH_CREDENTIAL_MISSING');
  });
});
