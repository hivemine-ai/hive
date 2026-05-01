// `hivectl serve [--port <n>] [--host <addr>] [--log-level <level>] [--log-pretty]`
//
// Foreground MCP server. Reuses the server composition root (`buildWire`)
// directly — same boot sequence, same graceful shutdown semantics.
//
// Per the hivectl + Admin Operations tech spec § "serve + service group":
//   - Foreground process. Blocks until SIGINT/SIGTERM.
//   - Logs to stdout/stderr — JSON by default; pretty only if `--log-pretty`
//     or `HIVE_MCP_LOG_PRETTY=true`.
//   - No daemonize, no PID file (delegate-to-OS — systemd / launchd via PRY-032).
//   - Flag precedence: flag > env > default. Flags map to a `WireConfig`
//     override + `LoggerOptions` fed directly to `buildWire` and `createLogger`
//     (env vars are read inside `resolveWireConfigFromEnv` for the unset
//     fields). `process.env` is never mutated on the production path.

import { buildWire, createLogger } from '@hive/server';
import type { LoggerOptions, Wire, WireConfig } from '@hive/server';

import { getDefaultConfigPath } from '../platform/detect.js';

import { readConfigFile, resolveHttpHost } from './config/loader.js';
import type { PersistedConfig } from './config/loader.js';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface ServeCommandOpts {
  port: number | undefined;
  host: string | undefined;
  logLevel: LogLevel | undefined;
  logPretty: boolean | undefined;
}

const VALID_LOG_LEVELS: ReadonlySet<LogLevel> = new Set([
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
]);

/**
 * Maps the `serve` CLI flags onto a `WireConfig` override and a `LoggerOptions`
 * value. Flags ALWAYS win over env vars (`buildWire` falls back to env when
 * the override is omitted, so undefined fields flow through transparently).
 *
 * Exported for unit testing.
 */
export function resolveServeOverrides(
  opts: ServeCommandOpts,
  env: NodeJS.ProcessEnv,
  configFile: PersistedConfig | null = null,
): { wire: WireConfig; logger: LoggerOptions } {
  const wire: WireConfig = {};
  if (opts.port !== undefined) wire.httpPort = opts.port;
  // httpHost precedence (PRY-032): flag > env > config file > default 127.0.0.1.
  // We always set `wire.httpHost` here so the server's resolveWireConfigFromEnv
  // default ('0.0.0.0') is never reached from the CLI path — closes
  // INC-2026-001 FLAG-005 (LAN bind by default without operator opt-in).
  wire.httpHost = resolveHttpHost({
    flag: opts.host,
    env: env['HIVE_MCP_HTTP_HOST'],
    configFile,
  });

  const logger: LoggerOptions = {};
  const levelFlag = opts.logLevel;
  const levelEnv = env['HIVE_MCP_LOG_LEVEL'];
  const resolvedLevel = levelFlag ?? levelEnv;
  if (resolvedLevel !== undefined) {
    logger.level = resolvedLevel as LogLevel | 'silent';
  }
  // pino-pretty defaults to ON when NODE_ENV !== 'production' inside
  // createLogger. Match the legacy `packages/server/src/main.ts` behaviour:
  // ALWAYS resolve to an explicit boolean here so JSON-only deployments
  // (CI smoke jobs, journald-piped systemd units) get JSON unless the
  // operator opts in with --log-pretty or HIVE_MCP_LOG_PRETTY=true.
  const prettyFlag = opts.logPretty;
  const prettyEnv = env['HIVE_MCP_LOG_PRETTY'];
  logger.pretty = prettyFlag ?? prettyEnv === 'true';
  return { wire, logger };
}

/**
 * Parses `--log-level` into the constrained union, throwing a clear error if
 * the value is not one of the six pino levels (matches the spec — no `silent`
 * exposed to the operator).
 *
 * Exported for unit testing.
 */
export function parseLogLevel(raw: string | undefined): LogLevel | undefined {
  if (raw === undefined) return undefined;
  if (!VALID_LOG_LEVELS.has(raw as LogLevel)) {
    throw new Error(
      `invalid --log-level "${raw}". Expected one of: ${[...VALID_LOG_LEVELS].join(', ')}`,
    );
  }
  return raw as LogLevel;
}

export interface SignalsProcess {
  on(event: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
  // Test-friendly: production passes `process` (whose `exit` is `never`-typed),
  // but tests inject a stub that returns. We keep the return type wide so the
  // post-`proc.exit` block remains reachable in TS analysis.
  exit(code?: number): void;
  exitCode?: number | undefined;
}

export interface RunServeDeps {
  /** Allows tests to swap the default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Allows tests to swap signal-handler installation + exit. */
  proc?: SignalsProcess;
  /** Test seam: replace `buildWire`. */
  buildWireFn?: typeof buildWire;
  /** Test seam: replace `createLogger`. */
  createLoggerFn?: typeof createLogger;
  /** Test seam: invoked once the wire has been built and successfully started. */
  onWireStarted?: (wire: Wire) => void;
  /** Override the persisted config path. Defaults to `getDefaultConfigPath()`. */
  configPath?: string;
  /** Test seam: replace the config-file reader. */
  readConfigFileFn?: (path: string) => PersistedConfig | null;
}

/**
 * Runs the foreground MCP server. This function blocks until the process is
 * signalled (SIGINT/SIGTERM) — at which point the wire is stopped gracefully
 * and the process exits with `process.exitCode ?? 0`.
 *
 * It does NOT throw on signal-driven shutdown; callers should treat a normal
 * return as "process is exiting". Returns only when `proc.exit` is mocked
 * (test path).
 */
export async function runServe(opts: ServeCommandOpts, deps: RunServeDeps = {}): Promise<void> {
  const env = deps.env ?? process.env;
  const proc: SignalsProcess = deps.proc ?? (process as unknown as SignalsProcess);
  const buildWireFn = deps.buildWireFn ?? buildWire;
  const createLoggerFn = deps.createLoggerFn ?? createLogger;
  const readCfg = deps.readConfigFileFn ?? readConfigFile;

  let configFile: PersistedConfig | null = null;
  let configReadError: Error | null = null;
  let resolvedConfigPath: string | null = null;
  try {
    resolvedConfigPath = deps.configPath ?? getDefaultConfigPath();
    configFile = readCfg(resolvedConfigPath);
  } catch (err) {
    // Best-effort: capture the error and surface it via the logger once it
    // exists (the read happens before logger creation because the persisted
    // `httpHost` may need to flow into the wire override). Falling back to
    // the env / default chain means the operator's config drift is silently
    // ignored unless we log here.
    configFile = null;
    configReadError = err instanceof Error ? err : new Error(String(err));
  }

  const { wire: wireOverrides, logger: loggerOpts } = resolveServeOverrides(opts, env, configFile);
  const logger = createLoggerFn(loggerOpts);

  if (configReadError !== null) {
    logger.warn(
      {
        event: 'config_file_read_failed',
        configPath: resolvedConfigPath,
        err: configReadError.message,
      },
      'config file unreadable; falling back to env/default for httpHost',
    );
  }

  let wire: Awaited<ReturnType<typeof buildWireFn>>;
  try {
    wire = await buildWireFn({ logger }, wireOverrides);
  } catch (err) {
    logger.error(
      { event: 'wire_boot_failed', err: err instanceof Error ? err.message : String(err) },
      'failed to bootstrap hive server',
    );
    // Must call proc.exit(1) explicitly — returning here lets commander +
    // main.ts collapse to process.exit(0) (stateRef is never populated by
    // this action handler, so getExitCode() falls back to 0). Without the
    // explicit exit, systemd / Docker would see a healthy 0 on a bootstrap
    // failure.
    proc.exitCode = 1;
    proc.exit(1);
    return;
  }

  let stopping = false;
  async function shutdown(signal: 'SIGTERM' | 'SIGINT'): Promise<void> {
    if (stopping) return;
    stopping = true;
    logger.info({ event: 'signal_received', signal }, 'shutdown signal received');
    try {
      await wire.stop();
    } catch (err) {
      logger.error(
        { event: 'wire_stop_unhandled', err: err instanceof Error ? err.message : String(err) },
        'unhandled error during wire.stop',
      );
      proc.exitCode = 1;
      proc.exit(proc.exitCode);
      return;
    }
    proc.exit(proc.exitCode ?? 0);
  }

  proc.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  proc.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  try {
    await wire.start();
  } catch (err) {
    logger.error(
      { event: 'wire_start_failed', err: err instanceof Error ? err.message : String(err) },
      'failed to start hive server',
    );
    // Same reasoning as the wire_boot_failed branch — explicit exit(1) is
    // mandatory here; commander + main.ts would otherwise drop the failure.
    proc.exitCode = 1;
    proc.exit(1);
    return;
  }

  if (deps.onWireStarted !== undefined) {
    deps.onWireStarted(wire);
  }

  // Block until a signal handler calls `proc.exit`. The promise never resolves
  // on the production path (the only resolutions come from tests injecting a
  // mock `proc` whose `exit` doesn't actually terminate).
  await new Promise<void>(() => {
    /* intentional indefinite block */
  });
}
