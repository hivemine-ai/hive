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
}

const DEFAULT_PLATFORM: PlatformLike = {
  get platform() {
    return process.platform;
  },
  homedir: () => os.homedir(),
  get env() {
    return process.env;
  },
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
 *   - Linux: `/var/lib/hive` (FHS-compliant data dir for system services).
 *   - Mac:   `~/Library/Application Support/Hive` (Apple HIG user-level data).
 */
export function getDefaultWorkingDir(p: PlatformLike = DEFAULT_PLATFORM): string {
  const platform = detectPlatform(p);
  if (platform === 'linux') return '/var/lib/hive';
  return path.join(p.homedir(), 'Library', 'Application Support', 'Hive');
}

/**
 * Default service user. Linux uses a dedicated `hive` system user (created at
 * install time if missing) — closes INC-2026-001 FLAG-002 (don't run as root).
 * Mac uses the calling user (launchd user-level agents always run as the
 * loading user; the field is informational only).
 */
export function getDefaultUser(p: PlatformLike = DEFAULT_PLATFORM): string {
  const platform = detectPlatform(p);
  if (platform === 'linux') return 'hive';
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
