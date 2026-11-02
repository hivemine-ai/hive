// Resolves the flags and environment of `hivectl watch` into one validated input.

import { join } from 'node:path';

import { WatchError } from './errors.js';

export interface RawWatchOptions {
  server?: string;
  credentialFile?: string;
  exec?: string;
  once?: boolean;
  silenceTimeout?: string;
  probeTimeout?: string;
  /** Operands after `--`. Only valid with `--exec`. */
  execArgs: string[];
}

export interface WatchInput {
  server: string;
  credentialFile: string;
  once: boolean;
  exec: { program: string; args: string[] } | undefined;
  silenceTimeoutMs: number;
  probeTimeoutMs: number;
  authRetryMaxMs: number;
  execMaxRetries: number;
  execStopTimeoutMs: number;
}

const DEFAULTS = {
  silenceSeconds: 45,
  probeSeconds: 20,
  authRetryMaxSeconds: 300,
  execMaxRetries: 3,
  execStopSeconds: 30,
};
/** The probe must give up before the SDK client's own 60 s default. */
const PROBE_LIMIT_SECONDS = 60;

function parseInteger(name: string, raw: string, min: number): number {
  if (!/^\d+$/.test(raw.trim())) {
    throw new WatchError('WATCH_INVALID_OPTION', `${name} must be a whole number, got "${raw}"`);
  }
  const value = Number(raw);
  if (value < min)
    throw new WatchError('WATCH_INVALID_OPTION', `${name} must be at least ${String(min)}`);
  return value;
}

function parseServer(raw: string | undefined): string {
  if (raw === undefined || raw === '') {
    throw new WatchError(
      'WATCH_SERVER_URL_MISSING',
      'no server URL: pass --server <url> or set HIVE_WATCH_SERVER_URL',
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WatchError('WATCH_INVALID_OPTION', `--server is not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WatchError('WATCH_INVALID_OPTION', '--server must be an http or https URL');
  }
  return url.toString();
}

/** Where the participant credential lives when no path is given. */
export function defaultCredentialPath(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
): string {
  if (platform === 'darwin')
    return join(home, 'Library', 'Application Support', 'hivectl', 'credential');
  if (platform === 'win32') {
    return join(env['APPDATA'] ?? join(home, 'AppData', 'Roaming'), 'hivectl', 'credential');
  }
  return join(env['XDG_CONFIG_HOME'] ?? join(home, '.config'), 'hivectl', 'credential');
}

export function resolveWatchInput(
  raw: RawWatchOptions,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  home = process.env['HOME'] ?? '',
): WatchInput {
  if (raw.once === true && raw.exec !== undefined) {
    throw new WatchError('WATCH_ONCE_EXEC_CONFLICT', '--once and --exec cannot be used together');
  }
  if (raw.exec === undefined && raw.execArgs.length > 0) {
    throw new WatchError(
      'WATCH_INVALID_OPTION',
      'unexpected arguments: they are only valid after --exec',
    );
  }
  const server = parseServer(raw.server ?? env['HIVE_WATCH_SERVER_URL']);

  const silenceSeconds = parseInteger(
    '--silence-timeout',
    raw.silenceTimeout ??
      env['HIVE_WATCH_SILENCE_TIMEOUT_SECONDS'] ??
      String(DEFAULTS.silenceSeconds),
    1,
  );
  const probeSeconds = parseInteger(
    '--probe-timeout',
    raw.probeTimeout ?? env['HIVE_WATCH_PROBE_TIMEOUT_SECONDS'] ?? String(DEFAULTS.probeSeconds),
    1,
  );
  if (probeSeconds >= PROBE_LIMIT_SECONDS) {
    throw new WatchError(
      'WATCH_INVALID_OPTION',
      `--probe-timeout must be below ${String(PROBE_LIMIT_SECONDS)} seconds`,
    );
  }
  const authRetrySeconds = parseInteger(
    'HIVE_WATCH_AUTH_RETRY_MAX_SECONDS',
    env['HIVE_WATCH_AUTH_RETRY_MAX_SECONDS'] ?? String(DEFAULTS.authRetryMaxSeconds),
    0,
  );
  const execMaxRetries = parseInteger(
    'HIVE_WATCH_EXEC_MAX_RETRIES',
    env['HIVE_WATCH_EXEC_MAX_RETRIES'] ?? String(DEFAULTS.execMaxRetries),
    0,
  );
  const execStopSeconds = parseInteger(
    'HIVE_WATCH_EXEC_STOP_TIMEOUT_SECONDS',
    env['HIVE_WATCH_EXEC_STOP_TIMEOUT_SECONDS'] ?? String(DEFAULTS.execStopSeconds),
    0,
  );

  return {
    server,
    credentialFile:
      raw.credentialFile ??
      env['HIVE_WATCH_CREDENTIAL_FILE'] ??
      defaultCredentialPath(platform, env, home),
    once: raw.once === true,
    exec: raw.exec === undefined ? undefined : { program: raw.exec, args: raw.execArgs },
    silenceTimeoutMs: silenceSeconds * 1000,
    probeTimeoutMs: probeSeconds * 1000,
    authRetryMaxMs: authRetrySeconds * 1000,
    execMaxRetries,
    execStopTimeoutMs: execStopSeconds * 1000,
  };
}
