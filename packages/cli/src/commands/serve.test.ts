// PRY-031 — `hivectl serve` subcommand.
//
// Unit tests cover the pure helpers (flag → env mapping, log-level parsing).
// The smoke test bootstraps a Hive on disk via `runInit`, fires `runServe`
// against an ephemeral port (via env), polls `/healthz` until the wire is up,
// then triggers the captured SIGINT handler and verifies graceful shutdown.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseLogLevel, resolveServeOverrides, runServe, type SignalsProcess } from './serve.js';
import type { LogLevel, ServeCommandOpts } from './serve.js';
import { runInit } from './init.js';
import type { GlobalCliOpts } from '../types.js';

describe('PRY-031 — resolveServeOverrides (flag → wire/logger config precedence)', () => {
  it('maps --port to wire.httpPort over HIVE_MCP_HTTP_PORT', () => {
    const env: NodeJS.ProcessEnv = { HIVE_MCP_HTTP_PORT: '9000' };
    const out = resolveServeOverrides(
      { port: 4000, host: undefined, logLevel: undefined, logPretty: undefined },
      env,
    );
    expect(out.wire.httpPort).toBe(4000);
    // env var stays untouched — the wire reads it as fallback when override
    // is omitted; we never mutate process.env on the production path.
    expect(env['HIVE_MCP_HTTP_PORT']).toBe('9000');
  });

  it('omits wire.httpPort when --port is undefined (env fallback path)', () => {
    const env: NodeJS.ProcessEnv = { HIVE_MCP_HTTP_PORT: '9000' };
    const out = resolveServeOverrides(
      { port: undefined, host: undefined, logLevel: undefined, logPretty: undefined },
      env,
    );
    expect(out.wire.httpPort).toBeUndefined();
  });

  it('maps --host to wire.httpHost', () => {
    const env: NodeJS.ProcessEnv = { HIVE_MCP_HTTP_HOST: '0.0.0.0' };
    const out = resolveServeOverrides(
      { port: undefined, host: '127.0.0.1', logLevel: undefined, logPretty: undefined },
      env,
    );
    expect(out.wire.httpHost).toBe('127.0.0.1');
  });

  it('maps --log-level to logger.level (flag wins over env)', () => {
    const env: NodeJS.ProcessEnv = { HIVE_MCP_LOG_LEVEL: 'info' };
    const out = resolveServeOverrides(
      { port: undefined, host: undefined, logLevel: 'debug', logPretty: undefined },
      env,
    );
    expect(out.logger.level).toBe('debug');
  });

  it('flows env log level when --log-level is omitted', () => {
    const env: NodeJS.ProcessEnv = { HIVE_MCP_LOG_LEVEL: 'warn' };
    const out = resolveServeOverrides(
      { port: undefined, host: undefined, logLevel: undefined, logPretty: undefined },
      env,
    );
    expect(out.logger.level).toBe('warn');
  });

  it('maps --log-pretty=true to logger.pretty=true', () => {
    const env: NodeJS.ProcessEnv = {};
    const out = resolveServeOverrides(
      { port: undefined, host: undefined, logLevel: undefined, logPretty: true },
      env,
    );
    expect(out.logger.pretty).toBe(true);
  });

  it('parses HIVE_MCP_LOG_PRETTY env var ("true" → true) when flag is omitted', () => {
    const env: NodeJS.ProcessEnv = { HIVE_MCP_LOG_PRETTY: 'true' };
    const out = resolveServeOverrides(
      { port: undefined, host: undefined, logLevel: undefined, logPretty: undefined },
      env,
    );
    expect(out.logger.pretty).toBe(true);
  });

  it('defaults logger.pretty=false when neither flag nor env is set (JSON output)', () => {
    const env: NodeJS.ProcessEnv = {};
    const out = resolveServeOverrides(
      { port: undefined, host: undefined, logLevel: undefined, logPretty: undefined },
      env,
    );
    expect(out.wire).toEqual({});
    // pretty MUST resolve to an explicit boolean — matches the legacy
    // packages/server/src/main.ts behaviour so journald/CI deployments get
    // JSON unless the operator opts in.
    expect(out.logger.pretty).toBe(false);
    expect(out.logger.level).toBeUndefined();
  });
});

describe('PRY-031 — parseLogLevel', () => {
  it.each<LogLevel>(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])('accepts %s', (level) => {
    expect(parseLogLevel(level)).toBe(level);
  });

  it('returns undefined when input is undefined', () => {
    expect(parseLogLevel(undefined)).toBeUndefined();
  });

  it('throws on invalid level (e.g. "silent" — exposed as a fatal-equivalent only via env, not the flag)', () => {
    expect(() => parseLogLevel('silent')).toThrow(/invalid --log-level "silent"/);
  });

  it('throws on garbage input', () => {
    expect(() => parseLogLevel('verbose')).toThrow(/invalid --log-level "verbose"/);
  });
});

function makeGlobals(): GlobalCliOpts {
  return { output: 'json', yes: true, noColor: true, verbose: false };
}

describe('PRY-031 — runServe (smoke E2E on ephemeral port)', () => {
  let workDir: string;
  let dbPath: string;
  let keysDir: string;
  const originalEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    'HIVE_DB_URL',
    'HIVE_DB_DIALECT',
    'HIVE_AUTH_KEYS_DIR',
    'HIVE_MCP_HTTP_HOST',
    'HIVE_MCP_HTTP_PORT',
    'HIVE_MCP_LOG_LEVEL',
    'HIVE_MCP_LOG_PRETTY',
    'HIVE_MCP_SHUTDOWN_DRAIN_TIMEOUT_SECONDS',
  ];

  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hivectl-serve-smoke-'));
    dbPath = path.join(workDir, 'hive.sqlite');
    keysDir = path.join(workDir, 'keys');
    for (const k of ENV_KEYS) {
      originalEnv[k] = process.env[k];
    }
    process.env['HIVE_DB_DIALECT'] = 'sqlite';
    process.env['HIVE_DB_URL'] = `sqlite:${dbPath}`;
    process.env['HIVE_AUTH_KEYS_DIR'] = keysDir;
    process.env['HIVE_MCP_LOG_LEVEL'] = 'silent';
    process.env['HIVE_MCP_SHUTDOWN_DRAIN_TIMEOUT_SECONDS'] = '5';
  });

  afterEach(async () => {
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it('starts the HTTP host on an ephemeral port and shuts down on SIGINT', async () => {
    // Bootstrap a Hive on disk via runInit (creates the schema + signing key
    // + first credential — same pattern as the cli/src/smoke.test.ts).
    await runInit({
      globals: makeGlobals(),
      adminEmail: 'leo@example.com',
      adminDisplayName: 'Leo',
      hiveName: 'Serve Smoke',
      db: `sqlite:${dbPath}`,
      keysDir,
      ttl: '365d',
      outputCredential: path.join(workDir, 'admin.jwt'),
    });

    const handlers: Partial<Record<'SIGTERM' | 'SIGINT', () => void>> = {};
    let exitCalls = 0;
    let lastExitCode: number | undefined;
    const fakeProc: SignalsProcess = {
      on(event, listener) {
        handlers[event] = listener;
        return undefined;
      },
      exit(code) {
        exitCalls += 1;
        lastExitCode = code;
      },
    };

    let observedPort: number | null = null;
    const opts: ServeCommandOpts = {
      port: 0, // OS-assigned ephemeral port (bypasses env var min:1 validation).
      host: '127.0.0.1',
      logLevel: undefined,
      logPretty: undefined,
    };

    // runServe blocks indefinitely on the production path — fire it without
    // awaiting, capture the wire via the test seam, and keep a handle on the
    // promise so we can await graceful shutdown later.
    const runPromise = runServe(opts, {
      proc: fakeProc,
      onWireStarted: (wire) => {
        observedPort = wire.port();
      },
    });

    // Poll until the wire has reported its port (deterministic — the seam
    // fires synchronously after wire.start() resolves).
    const startDeadline = Date.now() + 10_000;
    while (observedPort === null && Date.now() < startDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(observedPort).not.toBeNull();
    expect(observedPort).toBeGreaterThan(0);

    // /healthz should respond 200 — proves the listener is live.
    const healthz = await fetch(`http://127.0.0.1:${String(observedPort)}/healthz`);
    expect(healthz.status).toBe(200);

    // Trigger graceful shutdown via the captured SIGINT handler.
    expect(handlers.SIGINT).toBeDefined();
    handlers.SIGINT?.();

    // Wait for fakeProc.exit to be called (post wire.stop).
    const stopDeadline = Date.now() + 10_000;
    while (exitCalls === 0 && Date.now() < stopDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(exitCalls).toBe(1);
    expect(lastExitCode).toBe(0);

    // The /healthz should now fail to connect (server stopped). We don't
    // strictly need to assert this — proc.exit being called post wire.stop()
    // is the contract — but it's nice corroboration.
    await expect(
      fetch(`http://127.0.0.1:${String(observedPort)}/healthz`).then((r) => r.status),
    ).rejects.toBeTruthy();

    // The runServe promise itself never resolves (it parks on the indefinite
    // promise after start) — drop the handle so vitest doesn't flag it.
    void runPromise;
  }, 30_000);
});
