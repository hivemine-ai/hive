// `hivectl serve [--port <n>] [--host <addr>] [--log-level <level>] [--log-pretty]`
//
// Foreground MCP server. Reuses the server composition root (`buildWire`)
// directly — same boot sequence, same graceful shutdown semantics.
//
// Per the hivectl + Admin Operations tech spec § "serve + service group":
//   - Foreground process. Blocks until SIGINT/SIGTERM.
//   - Output: 3-phase formatted output by default (boot banner → readiness
//     line → live log stream via the inline pretty formatter from
//     `output/log-formatter.ts`). Operators opt out into raw JSON via
//     `--output=json` (global flag) or `HIVE_MCP_LOG_PRETTY=false`.
//   - No daemonize, no PID file (delegate-to-OS — systemd / launchd via PRY-032).
//   - Flag precedence: flag > env > default. Flags map to a `WireConfig`
//     override + `LoggerOptions` fed directly to `buildWire` and `createLogger`
//     (env vars are read inside `resolveWireConfigFromEnv` for the unset
//     fields). `process.env` is never mutated on the production path.
//
// Implements PRY-051 (Slice 4 of the hivectl Output Layer cascade per
// [[hivectl Output Layer + Status Snapshot]]).

import { buildWire, createLogger } from '@hive/server';
import type { LoggerOptions, Wire, WireConfig } from '@hive/server';
import { HIVE_DEFAULT_HTTP_HOST, HIVE_DEFAULT_HTTP_PORT } from '@hive/shared';
import type { DestinationStream } from 'pino';

import { getDefaultConfigPath } from '#platform/detect.js';
import { c } from '#output/colors.js';
import { compact as bannerCompact } from '#output/banner.js';
import { sym } from '#output/symbols.js';
import {
  determineModulePathPadding,
  formatLogLine,
  type FormatPadding,
} from '#output/log-formatter.js';
import { readSnapshot } from '#state/snapshot.js';

import { readConfigFile, resolveHttpHost } from './config/loader.js';
import type { PersistedConfig } from './config/loader.js';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface ServeCommandOpts {
  port: number | undefined;
  host: string | undefined;
  logLevel: LogLevel | undefined;
  logPretty: boolean | undefined;
  /**
   * Global `--output` value forwarded from program.ts. When `'json'`, the
   * 3-phase formatted output is suppressed and pino emits raw JSON to stdout
   * (log-shipper friendly, byte-stable across versions).
   */
  output?: string | undefined;
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
  // Pre-PRY-051 the `pretty` field routed pino through pino-pretty (worker
  // thread). Post-PRY-051 the inline formatter is the prettifier and pino
  // is always pointed at our DestinationStream when in formatted mode, so
  // `logger.pretty` is set to false unconditionally here — the legacy
  // `--log-pretty` flag and `HIVE_MCP_LOG_PRETTY=true` are no-ops kept for
  // backward compat (so old launch scripts don't error). The new opt-out
  // is `--output=json` or `HIVE_MCP_LOG_PRETTY=false` (handled in runServe).
  logger.pretty = false;
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

/**
 * JSON mode is triggered by either:
 *   - `--output=json` (global flag, forwarded via `opts.output`)
 *   - `HIVE_MCP_LOG_PRETTY=false` (legacy env opt-out, preserved for
 *     log-shipper deployments scripted against prior versions)
 *
 * In JSON mode, the 3-phase formatted output is suppressed entirely:
 *   - No boot banner (operators piping to jq want only valid JSON lines).
 *   - No readiness line.
 *   - Pino writes raw JSON directly to stdout (its default).
 *
 * Exported for unit testing.
 */
export function isJsonMode(opts: ServeCommandOpts, env: NodeJS.ProcessEnv): boolean {
  if (opts.output === 'json') return true;
  if (env['HIVE_MCP_LOG_PRETTY'] === 'false') return true;
  return false;
}

/**
 * Translates a database URL into the `<driver> · <location>` shape used in
 * the boot sub-block. SQLite paths are surfaced verbatim; Postgres URLs
 * have credentials stripped (mirrors the snapshot redaction from PRY-048).
 *
 * Exported for unit testing.
 */
export function formatDbLocation(rawUrl: string | undefined): string {
  if (rawUrl === undefined || rawUrl.length === 0) {
    return 'sqlite · ./var/db/hive.sqlite';
  }
  if (rawUrl.startsWith('sqlite:')) {
    return `sqlite · ${rawUrl.slice('sqlite:'.length)}`;
  }
  if (rawUrl.startsWith('postgres://') || rawUrl.startsWith('postgresql://')) {
    try {
      const u = new URL(rawUrl);
      const auth = u.username.length > 0 ? `${u.username}@` : '';
      return `postgres · ${auth}${u.host}${u.pathname}`;
    } catch {
      return 'postgres · <redacted>';
    }
  }
  return rawUrl;
}

export interface BootBannerInput {
  hiveName: string | null;
  bind: string;
  database: string;
  logLevel: string;
}

/**
 * Renders the 3-line compact banner + the boot sub-block (`bind`, `database`,
 * `log level`) followed by a blank line so the live log stream that comes
 * next sits in its own visual band.
 *
 * Exported for unit testing.
 */
export function renderBootBanner(input: BootBannerInput): string {
  const subtitle =
    input.hiveName !== null && input.hiveName.length > 0
      ? c.muted(`starting hive · ${input.hiveName}`)
      : c.muted('starting hive');
  const banner = bannerCompact(subtitle);
  const labelWidth = 11; // 'log level' (9) + 2 breathing spaces — keeps columns aligned.
  const subBlock = [
    `  ${c.muted('bind'.padEnd(labelWidth))}${input.bind}`,
    `  ${c.muted('database'.padEnd(labelWidth))}${input.database}`,
    `  ${c.muted('log level'.padEnd(labelWidth))}${input.logLevel}`,
  ].join('\n');
  return `${banner}\n\n${subBlock}\n`;
}

/**
 * Renders the readiness line (`⬡ ready · http://<bind>:<port>`).
 *
 * Exported for unit testing.
 */
export function renderReadiness(host: string, port: number): string {
  return `\n  ${c.ok(sym.prompt)} ${c.ok('ready')} ${c.muted('·')} ${c.muted(`http://${host}:${String(port)}`)}\n`;
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
  /**
   * Test seam: replace the snapshot reader (used to fetch hive name for the
   * boot banner). Defaults to `readSnapshot` from `#state/snapshot.js`. Tests
   * that don't care about the banner pass `() => Promise.resolve(null)`.
   */
  readSnapshotFn?: typeof readSnapshot;
  /**
   * Test seam: replace the stdout sink for banner + readiness writes. Defaults
   * to `process.stdout.write`. Tests pass an array sink to capture the output
   * for assertions without polluting the test runner's stdout.
   */
  outSink?: (line: string) => void;
}

function buildFormatterDest(
  padding: FormatPadding,
  sink: (line: string) => void,
): DestinationStream {
  return {
    write(jsonLine: string): void {
      const trimmed = jsonLine.endsWith('\n') ? jsonLine.slice(0, -1) : jsonLine;
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        sink(`${formatLogLine(parsed, padding)}\n`);
      } catch {
        // Pass through anything we can't parse — keeps surprising lines
        // visible to the operator instead of swallowing them silently.
        sink(jsonLine);
      }
    },
  };
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
  const readSnapshotFn = deps.readSnapshotFn ?? readSnapshot;
  const outSink =
    deps.outSink ??
    ((line: string): void => {
      process.stdout.write(line);
    });

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
  const jsonMode = isJsonMode(opts, env);

  // Phase 1 — boot banner + sub-block. Suppressed in JSON mode so log
  // shippers receive only valid JSON lines.
  if (!jsonMode) {
    let hiveName: string | null = null;
    try {
      const snap = await readSnapshotFn();
      hiveName = snap?.hive?.name ?? null;
    } catch {
      // Snapshot missing or unreadable is not fatal for boot — the banner
      // simply omits the hive-name suffix. The reader already swallows its
      // own errors, but defensive catch keeps boot resilient even if a
      // future change starts throwing.
      hiveName = null;
    }
    const bind = `${wireOverrides.httpHost ?? HIVE_DEFAULT_HTTP_HOST}:${wireOverrides.httpPort !== undefined ? String(wireOverrides.httpPort) : String(env['HIVE_MCP_HTTP_PORT'] ?? HIVE_DEFAULT_HTTP_PORT)}`;
    const database = formatDbLocation(env['HIVE_DB_URL']);
    const logLevel = loggerOpts.level ?? env['HIVE_LOG_LEVEL'] ?? 'info';
    outSink(renderBootBanner({ hiveName, bind, database, logLevel }));
  }

  // Phase 3 wiring (set up before logger creation so the formatter dest is
  // attached from the very first log line).
  const padding: FormatPadding = { modulePathWidth: determineModulePathPadding([]) };
  const dest: DestinationStream | undefined = jsonMode
    ? undefined
    : buildFormatterDest(padding, outSink);
  const logger = createLoggerFn(loggerOpts, dest);

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

  // Phase 2 — readiness line. Printed AFTER wire.start() resolves (HTTP
  // listener bound + healthy) so the line appears below any boot logs and
  // signals "the server is now answering requests". Suppressed in JSON mode.
  if (!jsonMode) {
    const boundPort = wire.port();
    if (boundPort !== null) {
      const host = wireOverrides.httpHost ?? '127.0.0.1';
      outSink(renderReadiness(host, boundPort));
    }
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
