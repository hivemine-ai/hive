// `hivectl service uninstall` — idempotent removal of the unit/plist plus
// supervisor reload. Pre-flight: if the service is currently active, stops
// it first with a warning to stderr.
//
// Per the hivectl + Admin Operations tech spec § "service uninstall".

import { existsSync, unlinkSync } from 'node:fs';

import { CliError } from '#error/cli-error.js';
import {
  detectPlatform,
  getDefaultUnitPath,
  LAUNCHD_LABEL,
  SYSTEMD_UNIT_NAME,
} from '#platform/detect.js';

import { realProcessRunner } from './exec.js';
import type { ProcessRunner } from './exec.js';

export interface RunServiceUninstallDeps {
  runner?: ProcessRunner;
  isRoot?: () => boolean;
  unitPath?: string;
  platform?: 'linux' | 'darwin';
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

export interface RunServiceUninstallResult {
  unitPath: string;
  removed: boolean;
  stoppedFirst: boolean;
  supervisor: 'systemd' | 'launchd';
}

export function runServiceUninstall(
  deps: RunServiceUninstallDeps = {},
): Promise<RunServiceUninstallResult> {
  const platform = deps.platform ?? detectPlatform();
  const runner = deps.runner ?? realProcessRunner;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const unitPath =
    deps.unitPath ??
    getDefaultUnitPath(
      platform === 'linux'
        ? {
            platform: 'linux',
            homedir: () => '/root',
            env: process.env,
            cwd: () => process.cwd(),
          }
        : {
            platform: 'darwin',
            homedir: () => process.env['HOME'] ?? '/',
            env: process.env,
            cwd: () => process.cwd(),
          },
    );
  const supervisor = platform === 'linux' ? 'systemd' : 'launchd';

  if (platform === 'linux') {
    const isRoot = deps.isRoot ? deps.isRoot() : process.geteuid?.() === 0;
    if (!isRoot) {
      throw new CliError('ROOT_REQUIRED', {
        message: `'service uninstall' on Linux must run as root. Try: sudo hivectl service uninstall`,
      });
    }
  }

  if (!existsSync(unitPath)) {
    stdout.write(`Service not installed (no unit/plist at ${unitPath}).\n`);
    return Promise.resolve({ unitPath, removed: false, stoppedFirst: false, supervisor });
  }

  let stoppedFirst = false;
  if (platform === 'linux') {
    const probe = runner.run('systemctl', ['is-active', SYSTEMD_UNIT_NAME]);
    const active = probe.stdout.trim() === 'active';
    if (active) {
      stderr.write(`warning: ${SYSTEMD_UNIT_NAME} is active; stopping before removal\n`);
      runner.run('systemctl', ['stop', SYSTEMD_UNIT_NAME]);
      stoppedFirst = true;
    }
  } else {
    // launchctl list <label> exits 0 when the agent is loaded.
    const probe = runner.run('launchctl', ['list', LAUNCHD_LABEL]);
    if (probe.status === 0) {
      stderr.write(`warning: ${LAUNCHD_LABEL} is loaded; unloading before removal\n`);
      runner.run('launchctl', ['unload', unitPath]);
      stoppedFirst = true;
    }
  }

  unlinkSync(unitPath);

  if (platform === 'linux') {
    runner.run('systemctl', ['daemon-reload']);
  }
  stdout.write(`Service uninstalled (removed ${unitPath}).\n`);
  return Promise.resolve({ unitPath, removed: true, stoppedFirst, supervisor });
}
