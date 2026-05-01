// `hivectl config network <local-only | bind-all>` — toggles the persisted
// bind address consumed by `hivectl serve` boot.
//
// Per the hivectl + Admin Operations tech spec § "config network":
//   - local-only → httpHost = 127.0.0.1 (default).
//   - bind-all   → httpHost = 0.0.0.0 + WARN to stderr (FLAG-005).

import { getDefaultConfigPath } from '#platform/detect.js';

import { readConfigFile, writeConfigFile } from './loader.js';

export type NetworkMode = 'local-only' | 'bind-all';

export const BIND_ALL_HOST = '0.0.0.0';
export const LOCAL_ONLY_HOST = '127.0.0.1';

const BIND_ALL_WARNING = [
  'WARNING: bind-all exposes the MCP server on all network interfaces.',
  '         Without TLS termination via a reverse proxy, JWTs travel in plaintext',
  '         (INC-2026-001 FLAG-005). See deployment/README.md § TLS termination.',
].join('\n');

export interface RunConfigNetworkInput {
  mode: NetworkMode;
  /** Override the default config path. Used by tests + the `--config` global. */
  configPath?: string;
}

export interface RunConfigNetworkDeps {
  /** Output sink for `local-only` confirmations + status output. */
  stdout?: NodeJS.WritableStream;
  /** Output sink for the bind-all warning. */
  stderr?: NodeJS.WritableStream;
}

export interface RunConfigNetworkResult {
  configPath: string;
  httpHost: string;
}

export function runConfigNetwork(
  input: RunConfigNetworkInput,
  deps: RunConfigNetworkDeps = {},
): Promise<RunConfigNetworkResult> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;

  const configPath = input.configPath ?? getDefaultConfigPath();
  const existing = readConfigFile(configPath);
  const httpHost = input.mode === 'bind-all' ? BIND_ALL_HOST : LOCAL_ONLY_HOST;

  writeConfigFile(configPath, { ...(existing ?? {}), httpHost });

  if (input.mode === 'bind-all') {
    stderr.write(`${BIND_ALL_WARNING}\n`);
    stdout.write(`bind-all set (httpHost=${BIND_ALL_HOST}). Restart the server to apply.\n`);
  } else {
    stdout.write(`local-only set (httpHost=${LOCAL_ONLY_HOST}). Restart the server to apply.\n`);
  }
  return Promise.resolve({ configPath, httpHost });
}
