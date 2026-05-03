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

import chalk from 'chalk';

import {
  formatDbLocation,
  isJsonMode,
  parseLogLevel,
  renderBootBanner,
  renderReadiness,
  resolveServeOverrides,
  runServe,
  type SignalsProcess,
} from './serve.js';
import type { LogLevel, RunServeDeps, ServeCommandOpts } from './serve.js';
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

  it('PRY-051: --log-pretty=true no longer routes pino-pretty (the inline formatter is default)', () => {
    const env: NodeJS.ProcessEnv = {};
    const out = resolveServeOverrides(
      { port: undefined, host: undefined, logLevel: undefined, logPretty: true },
      env,
    );
    // Post-PRY-051 the inline formatter is the prettifier; pino is always
    // pointed at our DestinationStream when in formatted mode, so we never
    // route through pino-pretty. The legacy flag is preserved (so old launch
    // scripts don't error) but is a no-op.
    expect(out.logger.pretty).toBe(false);
  });

  it('PRY-051: HIVE_MCP_LOG_PRETTY=true is a no-op alias (formatter is default)', () => {
    const env: NodeJS.ProcessEnv = { HIVE_MCP_LOG_PRETTY: 'true' };
    const out = resolveServeOverrides(
      { port: undefined, host: undefined, logLevel: undefined, logPretty: undefined },
      env,
    );
    expect(out.logger.pretty).toBe(false);
  });

  it('defaults logger.pretty=false when neither flag nor env is set (formatter is default)', () => {
    const env: NodeJS.ProcessEnv = {};
    const out = resolveServeOverrides(
      { port: undefined, host: undefined, logLevel: undefined, logPretty: undefined },
      env,
    );
    // Per PRY-032: httpHost defaults to 127.0.0.1 (local-only, closes
    // INC-2026-001 FLAG-005). Other fields stay unset.
    expect(out.wire).toEqual({ httpHost: '127.0.0.1' });
    // pretty MUST resolve to an explicit boolean — post-PRY-051 it is always
    // false (the inline formatter is the prettifier; pino doesn't route
    // through pino-pretty anymore from the CLI path).
    expect(out.logger.pretty).toBe(false);
    expect(out.logger.level).toBeUndefined();
  });

  // ── PRY-032: httpHost precedence (flag > env > config file > default) ──

  it('PRY-032: env HIVE_MCP_HTTP_HOST flows when --host flag is omitted', () => {
    const env: NodeJS.ProcessEnv = { HIVE_MCP_HTTP_HOST: '10.0.0.1' };
    const out = resolveServeOverrides(
      { port: undefined, host: undefined, logLevel: undefined, logPretty: undefined },
      env,
    );
    expect(out.wire.httpHost).toBe('10.0.0.1');
  });

  it('PRY-032: config file httpHost flows when both flag and env are unset', () => {
    const out = resolveServeOverrides(
      { port: undefined, host: undefined, logLevel: undefined, logPretty: undefined },
      {},
      { httpHost: '0.0.0.0' },
    );
    expect(out.wire.httpHost).toBe('0.0.0.0');
  });

  it('PRY-032: --host flag wins over env AND config file', () => {
    const out = resolveServeOverrides(
      { port: undefined, host: '127.0.0.1', logLevel: undefined, logPretty: undefined },
      { HIVE_MCP_HTTP_HOST: '10.0.0.1' },
      { httpHost: '0.0.0.0' },
    );
    expect(out.wire.httpHost).toBe('127.0.0.1');
  });

  it('PRY-032: env wins over config file when --host flag is unset', () => {
    const out = resolveServeOverrides(
      { port: undefined, host: undefined, logLevel: undefined, logPretty: undefined },
      { HIVE_MCP_HTTP_HOST: '10.0.0.1' },
      { httpHost: '0.0.0.0' },
    );
    expect(out.wire.httpHost).toBe('10.0.0.1');
  });

  it('PRY-032: defaults to 127.0.0.1 (local-only) when nothing is set — closes FLAG-005', () => {
    const out = resolveServeOverrides(
      { port: undefined, host: undefined, logLevel: undefined, logPretty: undefined },
      {},
      null,
    );
    expect(out.wire.httpHost).toBe('127.0.0.1');
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

type LoggerStub = {
  level: string;
  info: () => undefined;
  warn: () => undefined;
  error: (obj: unknown) => void;
  debug: () => undefined;
  trace: () => undefined;
  fatal: () => undefined;
  child: () => LoggerStub;
};

function makeLoggerStub(errorSink: unknown[]): LoggerStub {
  const stub: LoggerStub = {
    level: 'silent',
    info: () => undefined,
    warn: () => undefined,
    error: (obj: unknown) => {
      errorSink.push(obj);
    },
    debug: () => undefined,
    trace: () => undefined,
    fatal: () => undefined,
    child: () => stub,
  };
  return stub;
}

describe('PRY-031 — runServe failure paths', () => {
  it('exits with code 1 when buildWire throws (wire_boot_failed)', async () => {
    let exitCalls = 0;
    let lastExitCode: number | undefined;
    const fakeProc: SignalsProcess = {
      on() {
        return undefined;
      },
      exit(code) {
        exitCalls += 1;
        lastExitCode = code;
      },
    };
    const errorLogs: unknown[] = [];
    const fakeLogger = makeLoggerStub(errorLogs);

    await runServe(
      { port: undefined, host: undefined, logLevel: undefined, logPretty: undefined },
      {
        proc: fakeProc,
        createLoggerFn: ((): LoggerStub => fakeLogger) as unknown as NonNullable<
          RunServeDeps['createLoggerFn']
        >,
        buildWireFn: ((): Promise<never> =>
          Promise.reject(new Error('keys not found'))) as unknown as NonNullable<
          RunServeDeps['buildWireFn']
        >,
        readConfigFileFn: () => null,
      },
    );

    expect(exitCalls).toBe(1);
    expect(lastExitCode).toBe(1);
    const bootEvents = errorLogs.filter(
      (l): l is { event: string } =>
        typeof l === 'object' &&
        l !== null &&
        (l as { event?: string }).event === 'wire_boot_failed',
    );
    expect(bootEvents).toHaveLength(1);
  });

  it('exits with code 1 when wire.start() throws (wire_start_failed)', async () => {
    let exitCalls = 0;
    let lastExitCode: number | undefined;
    const fakeProc: SignalsProcess = {
      on() {
        return undefined;
      },
      exit(code) {
        exitCalls += 1;
        lastExitCode = code;
      },
    };
    const errorLogs: unknown[] = [];
    const fakeLogger = makeLoggerStub(errorLogs);
    const fakeWire = {
      start: (): Promise<void> => Promise.reject(new Error('listen EADDRINUSE')),
      stop: (): Promise<void> => Promise.resolve(),
      port: (): number | null => null,
      _httpHost: (): never => {
        throw new Error('test stub');
      },
      _cellEvents: (): never => {
        throw new Error('test stub');
      },
    };

    await runServe(
      { port: undefined, host: undefined, logLevel: undefined, logPretty: undefined },
      {
        proc: fakeProc,
        createLoggerFn: ((): LoggerStub => fakeLogger) as unknown as NonNullable<
          RunServeDeps['createLoggerFn']
        >,
        buildWireFn: ((): Promise<typeof fakeWire> =>
          Promise.resolve(fakeWire)) as unknown as NonNullable<RunServeDeps['buildWireFn']>,
        readConfigFileFn: () => null,
      },
    );

    expect(exitCalls).toBe(1);
    expect(lastExitCode).toBe(1);
    const startEvents = errorLogs.filter(
      (l): l is { event: string } =>
        typeof l === 'object' &&
        l !== null &&
        (l as { event?: string }).event === 'wire_start_failed',
    );
    expect(startEvents).toHaveLength(1);
  });
});

describe('PRY-051 — isJsonMode', () => {
  it('returns true when --output=json (global flag forwarded)', () => {
    expect(
      isJsonMode(
        {
          port: undefined,
          host: undefined,
          logLevel: undefined,
          logPretty: undefined,
          output: 'json',
        },
        {},
      ),
    ).toBe(true);
  });

  it('returns true when HIVE_MCP_LOG_PRETTY=false (legacy log-shipper opt-out)', () => {
    expect(
      isJsonMode(
        { port: undefined, host: undefined, logLevel: undefined, logPretty: undefined },
        { HIVE_MCP_LOG_PRETTY: 'false' },
      ),
    ).toBe(true);
  });

  it('returns false when --output is unset (formatted is default)', () => {
    expect(
      isJsonMode(
        { port: undefined, host: undefined, logLevel: undefined, logPretty: undefined },
        {},
      ),
    ).toBe(false);
  });

  it('returns false when --output=table (treated as formatted, not JSON)', () => {
    expect(
      isJsonMode(
        {
          port: undefined,
          host: undefined,
          logLevel: undefined,
          logPretty: undefined,
          output: 'table',
        },
        {},
      ),
    ).toBe(false);
  });

  it('returns false when --output=yaml (no JSON-mode behaviour for yaml; serve formats anyway)', () => {
    expect(
      isJsonMode(
        {
          port: undefined,
          host: undefined,
          logLevel: undefined,
          logPretty: undefined,
          output: 'yaml',
        },
        {},
      ),
    ).toBe(false);
  });

  it('returns false when HIVE_MCP_LOG_PRETTY=true (legacy alias, no-op post-PRY-051)', () => {
    expect(
      isJsonMode(
        { port: undefined, host: undefined, logLevel: undefined, logPretty: undefined },
        { HIVE_MCP_LOG_PRETTY: 'true' },
      ),
    ).toBe(false);
  });
});

describe('PRY-051 — formatDbLocation', () => {
  it('shows the SQLite path verbatim (the cli default)', () => {
    expect(formatDbLocation('sqlite:./var/db/hive.sqlite')).toBe('sqlite · ./var/db/hive.sqlite');
  });

  it('strips Postgres credentials before rendering host/database', () => {
    expect(formatDbLocation('postgres://hive:secret@db.example.com:5432/hivedb')).toBe(
      'postgres · hive@db.example.com:5432/hivedb',
    );
  });

  it('handles postgresql:// scheme variant', () => {
    expect(formatDbLocation('postgresql://hive:secret@db:5432/hivedb')).toBe(
      'postgres · hive@db:5432/hivedb',
    );
  });

  it('renders postgres without auth when no credentials present', () => {
    expect(formatDbLocation('postgres://db:5432/hivedb')).toBe('postgres · db:5432/hivedb');
  });

  it('falls back to "<redacted>" when the postgres URL is unparseable', () => {
    expect(formatDbLocation('postgres://malformed url with spaces')).toBe('postgres · <redacted>');
  });

  it('falls back to the SQLite default when env var is undefined', () => {
    expect(formatDbLocation(undefined)).toBe('sqlite · ./var/db/hive.sqlite');
  });

  it('falls back to the SQLite default when env var is empty', () => {
    expect(formatDbLocation('')).toBe('sqlite · ./var/db/hive.sqlite');
  });
});

describe('PRY-051 — renderBootBanner / renderReadiness (NO_COLOR byte-stable)', () => {
  const previousLevel = chalk.level;
  beforeEach(() => {
    chalk.level = 0;
  });
  afterEach(() => {
    chalk.level = previousLevel;
  });

  it('renders the compact banner + sub-block with hive name when known', () => {
    const out = renderBootBanner({
      hiveName: 'my-hive',
      bind: '127.0.0.1:7700',
      database: 'sqlite · ./var/db/hive.sqlite',
      logLevel: 'info',
    });
    // Banner first 3 lines (compact shape) + blank + 3 sub-block lines + trailing newline.
    const lines = out.split('\n');
    expect(lines).toHaveLength(8); // 3 banner + 1 blank + 3 sub-block + trailing ''
    expect(lines[2]).toContain('starting hive · my-hive');
    expect(lines[3]).toBe('');
    expect(lines[4]).toBe('  bind       127.0.0.1:7700');
    expect(lines[5]).toBe('  database   sqlite · ./var/db/hive.sqlite');
    expect(lines[6]).toBe('  log level  info');
    expect(lines[7]).toBe('');
  });

  it('omits the hive-name suffix when snapshot is missing', () => {
    const out = renderBootBanner({
      hiveName: null,
      bind: '127.0.0.1:7700',
      database: 'sqlite · ./var/db/hive.sqlite',
      logLevel: 'info',
    });
    const lines = out.split('\n');
    expect(lines[2]).toContain('starting hive');
    expect(lines[2]).not.toContain('starting hive ·');
  });

  it('omits the hive-name suffix when snapshot returns empty hive name', () => {
    const out = renderBootBanner({
      hiveName: '',
      bind: '127.0.0.1:7700',
      database: 'sqlite · ./var/db/hive.sqlite',
      logLevel: 'info',
    });
    const lines = out.split('\n');
    expect(lines[2]).toContain('starting hive');
    expect(lines[2]).not.toContain('starting hive ·');
  });

  it('renders the readiness line with the prompt glyph + bind url', () => {
    const out = renderReadiness('127.0.0.1', 7700);
    // Leading newline (visual band separator) + 2-space indent + glyph + body + trailing newline.
    expect(out).toBe('\n  ⬡ ready · http://127.0.0.1:7700\n');
  });

  it('renders ipv6 addresses without bracket-wrapping (operator-supplied bind is verbatim)', () => {
    const out = renderReadiness('::1', 7700);
    expect(out).toBe('\n  ⬡ ready · http://::1:7700\n');
  });
});

describe('PRY-051 — runServe 3-phase output (formatted mode)', () => {
  const previousLevel = chalk.level;
  beforeEach(() => {
    chalk.level = 0; // byte-stable assertions across CI/dev terminals.
  });
  afterEach(() => {
    chalk.level = previousLevel;
  });

  it('writes boot banner pre-build and readiness line post-start (formatted mode)', async () => {
    const sink: string[] = [];
    let exitCalls = 0;
    const fakeProc: SignalsProcess = {
      on() {
        return undefined;
      },
      exit() {
        exitCalls += 1;
      },
    };
    const handlers: Partial<Record<'SIGTERM' | 'SIGINT', () => void>> = {};
    const fakeWire = {
      start: (): Promise<void> => Promise.resolve(),
      stop: (): Promise<void> => Promise.resolve(),
      port: (): number | null => 7700,
      _httpHost: (): never => {
        throw new Error('test stub');
      },
      _cellEvents: (): never => {
        throw new Error('test stub');
      },
    };
    const fakeLogger = makeLoggerStub([]);
    fakeProc.on = (event, listener) => {
      handlers[event] = listener;
      return undefined;
    };

    const runPromise = runServe(
      { port: undefined, host: '127.0.0.1', logLevel: undefined, logPretty: undefined },
      {
        proc: fakeProc,
        outSink: (line) => {
          sink.push(line);
        },
        createLoggerFn: ((): typeof fakeLogger => fakeLogger) as unknown as NonNullable<
          RunServeDeps['createLoggerFn']
        >,
        buildWireFn: ((): Promise<typeof fakeWire> =>
          Promise.resolve(fakeWire)) as unknown as NonNullable<RunServeDeps['buildWireFn']>,
        readConfigFileFn: () => null,
        readSnapshotFn: () =>
          Promise.resolve({
            v: 1,
            writtenAt: '2026-05-03T00:00:00.000Z',
            heartbeatSeconds: 30,
            hive: { name: 'serve-smoke', colonies: 1, keepers: 1, agents: 1 },
            server: null,
            database: { driver: 'sqlite', location: './var/db/hive.sqlite' },
            lastAudit: null,
          }),
      },
    );

    // Yield to the event loop so the boot banner + onWireStarted fire.
    await new Promise((resolve) => setTimeout(resolve, 25));

    // Trigger graceful shutdown so the indefinite-block promise resolves
    // (test path — fakeProc.exit returns rather than terminating).
    handlers.SIGINT?.();
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(exitCalls).toBeGreaterThanOrEqual(1);
    void runPromise;

    // Sink should contain banner block (1st write) + readiness line.
    const concatenated = sink.join('');
    expect(concatenated).toContain('starting hive · serve-smoke');
    expect(concatenated).toContain('  bind       127.0.0.1:');
    expect(concatenated).toContain('  ⬡ ready · http://127.0.0.1:7700');
  });

  it('JSON mode emits NO banner, NO readiness, NO formatter wrapping', async () => {
    const sink: string[] = [];
    let exitCalls = 0;
    const fakeProc: SignalsProcess = {
      on() {
        return undefined;
      },
      exit() {
        exitCalls += 1;
      },
    };
    const handlers: Partial<Record<'SIGTERM' | 'SIGINT', () => void>> = {};
    const fakeWire = {
      start: (): Promise<void> => Promise.resolve(),
      stop: (): Promise<void> => Promise.resolve(),
      port: (): number | null => 7700,
      _httpHost: (): never => {
        throw new Error('test stub');
      },
      _cellEvents: (): never => {
        throw new Error('test stub');
      },
    };
    let createLoggerCallDest: unknown = 'unset';
    const fakeLogger = makeLoggerStub([]);
    fakeProc.on = (event, listener) => {
      handlers[event] = listener;
      return undefined;
    };

    const runPromise = runServe(
      {
        port: undefined,
        host: '127.0.0.1',
        logLevel: undefined,
        logPretty: undefined,
        output: 'json',
      },
      {
        proc: fakeProc,
        outSink: (line) => {
          sink.push(line);
        },
        createLoggerFn: ((_opts: unknown, dest: unknown): typeof fakeLogger => {
          createLoggerCallDest = dest;
          return fakeLogger;
        }) as unknown as NonNullable<RunServeDeps['createLoggerFn']>,
        buildWireFn: ((): Promise<typeof fakeWire> =>
          Promise.resolve(fakeWire)) as unknown as NonNullable<RunServeDeps['buildWireFn']>,
        readConfigFileFn: () => null,
        readSnapshotFn: () => Promise.resolve(null),
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 25));
    handlers.SIGINT?.();
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(exitCalls).toBeGreaterThanOrEqual(1);
    void runPromise;

    // No banner, no readiness — sink stays empty.
    expect(sink).toEqual([]);
    // createLogger was called with `dest === undefined` so pino emits raw
    // JSON via its default destination (process.stdout).
    expect(createLoggerCallDest).toBeUndefined();
  });

  it('HIVE_MCP_LOG_PRETTY=false env triggers JSON mode (legacy alias preserved)', async () => {
    const sink: string[] = [];
    let exitCalls = 0;
    const fakeProc: SignalsProcess = {
      on() {
        return undefined;
      },
      exit() {
        exitCalls += 1;
      },
    };
    const handlers: Partial<Record<'SIGTERM' | 'SIGINT', () => void>> = {};
    const fakeWire = {
      start: (): Promise<void> => Promise.resolve(),
      stop: (): Promise<void> => Promise.resolve(),
      port: (): number | null => 7700,
      _httpHost: (): never => {
        throw new Error('test stub');
      },
      _cellEvents: (): never => {
        throw new Error('test stub');
      },
    };
    let createLoggerCallDest: unknown = 'unset';
    const fakeLogger = makeLoggerStub([]);
    fakeProc.on = (event, listener) => {
      handlers[event] = listener;
      return undefined;
    };

    const runPromise = runServe(
      { port: undefined, host: '127.0.0.1', logLevel: undefined, logPretty: undefined },
      {
        env: { HIVE_MCP_LOG_PRETTY: 'false' },
        proc: fakeProc,
        outSink: (line) => {
          sink.push(line);
        },
        createLoggerFn: ((_opts: unknown, dest: unknown): typeof fakeLogger => {
          createLoggerCallDest = dest;
          return fakeLogger;
        }) as unknown as NonNullable<RunServeDeps['createLoggerFn']>,
        buildWireFn: ((): Promise<typeof fakeWire> =>
          Promise.resolve(fakeWire)) as unknown as NonNullable<RunServeDeps['buildWireFn']>,
        readConfigFileFn: () => null,
        readSnapshotFn: () => Promise.resolve(null),
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 25));
    handlers.SIGINT?.();
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(exitCalls).toBeGreaterThanOrEqual(1);
    void runPromise;

    expect(sink).toEqual([]);
    expect(createLoggerCallDest).toBeUndefined();
  });

  it('formatter dest is wired in formatted mode (createLogger receives a dest)', async () => {
    let exitCalls = 0;
    const fakeProc: SignalsProcess = {
      on() {
        return undefined;
      },
      exit() {
        exitCalls += 1;
      },
    };
    const handlers: Partial<Record<'SIGTERM' | 'SIGINT', () => void>> = {};
    const fakeWire = {
      start: (): Promise<void> => Promise.resolve(),
      stop: (): Promise<void> => Promise.resolve(),
      port: (): number | null => 7700,
      _httpHost: (): never => {
        throw new Error('test stub');
      },
      _cellEvents: (): never => {
        throw new Error('test stub');
      },
    };
    let createLoggerCallDest: unknown = 'unset';
    const fakeLogger = makeLoggerStub([]);
    fakeProc.on = (event, listener) => {
      handlers[event] = listener;
      return undefined;
    };

    const runPromise = runServe(
      { port: undefined, host: '127.0.0.1', logLevel: undefined, logPretty: undefined },
      {
        proc: fakeProc,
        outSink: () => undefined,
        createLoggerFn: ((_opts: unknown, dest: unknown): typeof fakeLogger => {
          createLoggerCallDest = dest;
          return fakeLogger;
        }) as unknown as NonNullable<RunServeDeps['createLoggerFn']>,
        buildWireFn: ((): Promise<typeof fakeWire> =>
          Promise.resolve(fakeWire)) as unknown as NonNullable<RunServeDeps['buildWireFn']>,
        readConfigFileFn: () => null,
        readSnapshotFn: () => Promise.resolve(null),
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 25));
    handlers.SIGINT?.();
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(exitCalls).toBeGreaterThanOrEqual(1);
    void runPromise;

    expect(createLoggerCallDest).toBeDefined();
    expect(typeof (createLoggerCallDest as { write: unknown } | null)?.write).toBe('function');
  });

  it('formatter dest formats JSON lines and writes them to the sink', async () => {
    const sink: string[] = [];
    let capturedDest: { write(msg: string): void } | undefined;
    let exitCalls = 0;
    const fakeProc: SignalsProcess = {
      on() {
        return undefined;
      },
      exit() {
        exitCalls += 1;
      },
    };
    const handlers: Partial<Record<'SIGTERM' | 'SIGINT', () => void>> = {};
    const fakeWire = {
      start: (): Promise<void> => Promise.resolve(),
      stop: (): Promise<void> => Promise.resolve(),
      port: (): number | null => 7700,
      _httpHost: (): never => {
        throw new Error('test stub');
      },
      _cellEvents: (): never => {
        throw new Error('test stub');
      },
    };
    const fakeLogger = makeLoggerStub([]);
    fakeProc.on = (event, listener) => {
      handlers[event] = listener;
      return undefined;
    };

    const runPromise = runServe(
      { port: undefined, host: '127.0.0.1', logLevel: undefined, logPretty: undefined },
      {
        proc: fakeProc,
        outSink: (line) => {
          sink.push(line);
        },
        createLoggerFn: ((_opts: unknown, dest: unknown): typeof fakeLogger => {
          capturedDest = dest as { write(msg: string): void } | undefined;
          return fakeLogger;
        }) as unknown as NonNullable<RunServeDeps['createLoggerFn']>,
        buildWireFn: ((): Promise<typeof fakeWire> =>
          Promise.resolve(fakeWire)) as unknown as NonNullable<RunServeDeps['buildWireFn']>,
        readConfigFileFn: () => null,
        readSnapshotFn: () => Promise.resolve(null),
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(capturedDest).toBeDefined();

    // Simulate pino emitting one JSON line through the dest.
    const initialSinkLen = sink.length;
    capturedDest!.write(
      `${JSON.stringify({
        level: 30,
        time: 1_770_000_000_000,
        module: 'composition.wire',
        msg: 'wire_started',
        port: 7700,
      })}\n`,
    );
    expect(sink.length).toBe(initialSinkLen + 1);
    const formatted = sink[sink.length - 1]!;
    expect(formatted).toContain('INFO ');
    expect(formatted).toContain('composition.wire');
    expect(formatted).toContain('wire_started');
    expect(formatted).toContain('port=7700');
    expect(formatted.endsWith('\n')).toBe(true);

    // Malformed JSON should pass through unchanged (defensive — never swallow).
    capturedDest!.write('not-valid-json\n');
    expect(sink[sink.length - 1]).toBe('not-valid-json\n');

    handlers.SIGINT?.();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(exitCalls).toBeGreaterThanOrEqual(1);
    void runPromise;
  });
});
