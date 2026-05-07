// OS detection helper shared by `hivectl service *` and `hivectl config network`.
// Per the hivectl + Admin Operations tech spec § "Detección de OS compartida".
//
// Linux + Mac are first-class for v0.1 OSS. Windows is intentionally
// out-of-scope per ADR-019 (the Docker path documented in deployment/README.md
// is the official Windows route).

import os from 'node:os';
import path from 'node:path';

import { CliError } from '#error/cli-error.js';

export type SupportedPlatform = 'linux' | 'darwin';

export interface PlatformLike {
  platform: NodeJS.Platform;
  homedir(): string;
  env: NodeJS.ProcessEnv;
  /** Returns the current working directory of the invoking process. Used by
   * `getDefaultWorkingDir` so the Linux default tracks the operator's cwd
   * (where they ran `hivectl init`) instead of forcing a system-wide path. */
  cwd(): string;
}

const DEFAULT_PLATFORM: PlatformLike = {
  get platform() {
    return process.platform;
  },
  homedir: () => os.homedir(),
  get env() {
    return process.env;
  },
  cwd: () => process.cwd(),
};

/**
 * Returns the supported OS for service-group commands. Throws a `CliError`
 * with code `UNSUPPORTED_PLATFORM` on any other platform — the error message
 * points the operator to the Docker path in `deployment/README.md`.
 */
export function detectPlatform(p: PlatformLike = DEFAULT_PLATFORM): SupportedPlatform {
  switch (p.platform) {
    case 'linux':
      return 'linux';
    case 'darwin':
      return 'darwin';
    default:
      throw new CliError('UNSUPPORTED_PLATFORM', {
        message: `'${p.platform}' is not supported — see deployment/README.md for the Docker path on Windows`,
      });
  }
}

/**
 * Default working directory per platform. Operator can override via
 * `--working-dir` on `service install` / `config network`.
 *
 *   - Linux: the invoking process's cwd. The operator typically runs
 *            `hivectl init` from a chosen directory (`~/test`, `~/work/hive`,
 *            `/srv/hive`) and expects `service install` to wire the unit to
 *            that same directory. Forcing `/var/lib/hive` (the previous
 *            default) required the operator to manually copy state across
 *            paths and was the most common cause of "service installed but
 *            won't start" support tickets through v0.1.7. Operators who do
 *            want the FHS layout pass `--working-dir /var/lib/hive`
 *            explicitly.
 *   - Mac:   `~/Library/Application Support/Hive` (Apple HIG user-level data).
 */
export function getDefaultWorkingDir(p: PlatformLike = DEFAULT_PLATFORM): string {
  const platform = detectPlatform(p);
  if (platform === 'linux') return p.cwd();
  return path.join(p.homedir(), 'Library', 'Application Support', 'Hive');
}

/**
 * Default service user. The intent is "run the service as the operator who
 * invoked the install" so the unit can read the state the operator already
 * created with `hivectl init`. Resolution order:
 *
 *   1. `SUDO_USER`   — set by sudo to the pre-elevation identity. The most
 *                      common case: the operator runs `sudo hivectl service
 *                      install` from their own shell.
 *   2. `USER` / `LOGNAME` — fallbacks when not invoked via sudo (e.g. running
 *                      directly as root, or in a container without sudo).
 *   3. `'root'`      — final fallback. systemd accepts `User=root` and
 *                      runs the service as PID 1's owner.
 *
 * Operators who want the previous Linux default (`User=hive`, dedicated
 * system user, INC-2026-001 FLAG-002 hardening) pass `--user hive`
 * explicitly. The flag also creates the user via `useradd` if missing.
 */
export function getDefaultUser(p: PlatformLike = DEFAULT_PLATFORM): string {
  const platform = detectPlatform(p);
  if (platform === 'linux') {
    return p.env['SUDO_USER'] ?? p.env['USER'] ?? p.env['LOGNAME'] ?? 'root';
  }
  return p.env['USER'] ?? p.env['LOGNAME'] ?? 'unknown';
}

/**
 * Default config file path. Sibling of the working directory; consumed by
 * `hivectl serve` boot to resolve the bind address (precedence: flag > env >
 * config file > default `127.0.0.1`).
 */
export function getDefaultConfigPath(p: PlatformLike = DEFAULT_PLATFORM): string {
  return path.join(getDefaultWorkingDir(p), 'config.json');
}

/**
 * Default unit/plist path written by `service install`. Consumed by `service
 * uninstall` and the `service status` parser.
 */
export function getDefaultUnitPath(p: PlatformLike = DEFAULT_PLATFORM): string {
  const platform = detectPlatform(p);
  if (platform === 'linux') return '/etc/systemd/system/hive.service';
  return path.join(p.homedir(), 'Library', 'LaunchAgents', 'com.hivemine.hivectl.plist');
}

/**
 * Default log paths written by the launchd plist (Mac only — Linux uses
 * journald and stores nothing on disk).
 */
export interface MacLogPaths {
  stdoutPath: string;
  stderrPath: string;
}

export function getDefaultMacLogPaths(p: PlatformLike = DEFAULT_PLATFORM): MacLogPaths {
  if (detectPlatform(p) !== 'darwin') {
    throw new CliError('UNSUPPORTED_PLATFORM', {
      message: 'launchd log paths are only relevant on darwin',
    });
  }
  const base = path.join(p.homedir(), 'Library', 'Logs', 'Hive');
  return {
    stdoutPath: path.join(base, 'hive.log'),
    stderrPath: path.join(base, 'hive.err'),
  };
}

export const LAUNCHD_LABEL = 'com.hivemine.hivectl';
export const SYSTEMD_UNIT_NAME = 'hive';
