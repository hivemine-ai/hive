// INC-2026-008: a revocation or rotation made by `hivectl` must bind the running
// server on its very next request, without a restart. `hivectl` and `hivectl serve`
// are separate OS processes sharing only the database, so this test drives both as
// real child processes from the compiled CLI. Requires `pnpm build` first.
//
// The probe only asserts on the Bearer verdict at the HTTP edge. That keeps the test
// independent from the MCP protocol revision served behind it.

import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const CLI_ENTRY = fileURLToPath(new URL('../dist/main.js', import.meta.url));

interface ServerLogLine {
  event?: string;
  domainCode?: string | null;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

describe('INC-2026-008: revocation reaches a running server across processes', () => {
  let workDir: string;
  let env: NodeJS.ProcessEnv;
  let baseUrl: string;
  let server: ChildProcess;
  let serverOutput = '';

  async function hivectl(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(process.execPath, [CLI_ENTRY, ...args], { env });
    return stdout;
  }

  async function createAgent(
    name: string,
    adminEmail: string,
  ): Promise<{ jwt: string; jti: string }> {
    const jwtPath = path.join(workDir, `${name}.jwt`);
    const created = JSON.parse(
      await hivectl([
        '--output',
        'json',
        '--operator-id',
        adminEmail,
        'agent',
        'create',
        '--name',
        name,
        '--owner',
        adminEmail,
        '--type',
        'worker',
        '--emit-credential',
        '--output-credential',
        jwtPath,
      ]),
    ) as { credentialJti: string };
    return { jwt: (await fs.readFile(jwtPath, 'utf8')).trim(), jti: created.credentialJti };
  }

  async function probe(jwt: string): Promise<{ status: number; code: number | undefined }> {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${jwt}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const text = await res.text();
    let code: number | undefined;
    try {
      code = (JSON.parse(text) as { error?: { code?: number } }).error?.code;
    } catch {
      code = undefined;
    }
    return { status: res.status, code };
  }

  function authFailures(): ServerLogLine[] {
    return serverOutput
      .split('\n')
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as ServerLogLine];
        } catch {
          return [];
        }
      })
      .filter((line) => line.event === 'mcp_auth_failed');
  }

  async function waitForRevokedLog(): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      if (authFailures().some((line) => line.domainCode === 'CREDENTIAL_REVOKED')) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`no CREDENTIAL_REVOKED log line in server output:\n${serverOutput}`);
  }

  async function waitUntilReady(): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${baseUrl}/readyz`);
        if (res.status === 200) return;
      } catch {
        // Not listening yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`server did not become ready:\n${serverOutput}`);
  }

  beforeAll(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-inc-2026-008-'));
    const dbUrl = `sqlite:${path.join(workDir, 'hive.sqlite')}`;
    const keysDir = path.join(workDir, 'keys');
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    env = {
      ...process.env,
      HIVE_DB_URL: dbUrl,
      HIVE_AUTH_KEYS_DIR: keysDir,
      HIVE_MCP_HTTP_HOST: '127.0.0.1',
      HIVE_MCP_HTTP_PORT: String(port),
      HIVE_MCP_LOG_LEVEL: 'info',
      HIVE_MCP_LOG_PRETTY: 'false',
    };

    await hivectl([
      'init',
      '--admin-email',
      'keeper@hive.test',
      '--db',
      dbUrl,
      '--keys-dir',
      keysDir,
      '--output-credential',
      path.join(workDir, 'admin.jwt'),
    ]);

    server = spawn(process.execPath, [CLI_ENTRY, 'serve'], { env });
    server.stdout?.on('data', (chunk: Buffer) => {
      serverOutput += chunk.toString();
    });
    server.stderr?.on('data', (chunk: Buffer) => {
      serverOutput += chunk.toString();
    });
    await waitUntilReady();
  }, 60_000);

  afterAll(async () => {
    if (server && server.exitCode === null) {
      const exited = new Promise((resolve) => server.once('exit', resolve));
      server.kill('SIGTERM');
      await exited;
    }
    await fs.rm(workDir, { recursive: true, force: true });
  }, 30_000);

  it('rejects a credential revoked by hivectl on the next request', async () => {
    const agent = await createAgent('revoked-worker', 'keeper@hive.test');
    expect((await probe(agent.jwt)).status).not.toBe(401);

    await hivectl([
      '--yes',
      '--operator-id',
      'keeper@hive.test',
      'credential',
      'revoke',
      agent.jti,
    ]);

    expect(await probe(agent.jwt)).toEqual({ status: 401, code: -32001 });
    await waitForRevokedLog();
  }, 30_000);

  it('rejects the previous credential after hivectl rotates it, and accepts the new one', async () => {
    const agent = await createAgent('rotated-worker', 'keeper@hive.test');
    expect((await probe(agent.jwt)).status).not.toBe(401);

    const rotatedPath = path.join(workDir, 'rotated.jwt');
    await hivectl([
      '--yes',
      '--operator-id',
      'keeper@hive.test',
      'credential',
      'rotate',
      agent.jti,
      '--output-credential',
      rotatedPath,
    ]);
    const rotatedJwt = (await fs.readFile(rotatedPath, 'utf8')).trim();

    expect(await probe(agent.jwt)).toEqual({ status: 401, code: -32001 });
    expect((await probe(rotatedJwt)).status).not.toBe(401);
  }, 30_000);
});
