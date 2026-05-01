// Thin wrappers for `hivectl service start | stop | restart`. Each delegates
// to the OS process supervisor (systemctl on Linux, launchctl on Mac) — no
// reimplementation of supervision per ADR-019 alternative B.2; the wrappers
// exist so the operator has a single CLI for the whole lifecycle.
//
// Per the hivectl + Admin Operations tech spec § "service start/stop/restart".
// All three are fire-and-forget — the operator runs `hivectl service status`
// after the command to verify state.

import { existsSync } from 'node:fs';

import { CliError } from '#error/cli-error.js';
import { detectPlatform, getDefaultUnitPath, SYSTEMD_UNIT_NAME } from '#platform/detect.js';

import { realProcessRunner } from './exec.js';
import type { ProcessRunner } from './exec.js';

export type LifecycleVerb = 'start' | 'stop' | 'restart';

export interface RunLifecycleDeps {
  runner?: ProcessRunner;
  unitPath?: string;
  platform?: 'linux' | 'darwin';
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

export interface RunLifecycleResult {
  ok: boolean;
  status: number | null;
  message: string;
}

export function runServiceLifecycle(
  verb: LifecycleVerb,
  deps: RunLifecycleDeps = {},
): Promise<RunLifecycleResult> {
  const platform = deps.platform ?? detectPlatform();
  const runner = deps.runner ?? realProcessRunner;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const unitPath =
    deps.unitPath ??
    getDefaultUnitPath(
      platform === 'linux'
        ? { platform: 'linux', homedir: () => '/root', env: process.env }
        : { platform: 'darwin', homedir: () => process.env['HOME'] ?? '/', env: process.env },
    );

  if (!existsSync(unitPath)) {
    throw new CliError('SERVICE_NOT_INSTALLED', {
      message: `service unit/plist not found at ${unitPath}. Run: hivectl service install`,
    });
  }

  if (platform === 'linux') {
    return Promise.resolve(runLinuxLifecycle(verb, { runner, stdout, stderr }));
  }
  return Promise.resolve(runDarwinLifecycle(verb, { runner, stdout, stderr, unitPath }));
}

interface LinuxLifecycleDeps {
  runner: ProcessRunner;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

function runLinuxLifecycle(verb: LifecycleVerb, deps: LinuxLifecycleDeps): RunLifecycleResult {
  const args = [verb, SYSTEMD_UNIT_NAME];
  const r = deps.runner.run('systemctl', args);
  const ok = r.status === 0;
  // `systemctl stop` on an already-stopped unit returns 0 with no output.
  // `systemctl start` on a missing unit (rare — caller pre-flight checked)
  // returns non-zero; bubble up via stderr.
  if (!ok) {
    const detail = (r.stderr || r.stdout).trim();
    deps.stderr.write(`error: systemctl ${verb} failed: ${detail}\n`);
    return { ok: false, status: r.status, message: detail };
  }
  deps.stdout.write(`Service ${verb}ed. Run: hivectl service status\n`);
  return { ok: true, status: r.status, message: '' };
}

interface DarwinLifecycleDeps {
  runner: ProcessRunner;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  unitPath: string;
}

function runDarwinLifecycle(verb: LifecycleVerb, deps: DarwinLifecycleDeps): RunLifecycleResult {
  // launchctl: load / unload / load+load-reload (no atomic restart).
  switch (verb) {
    case 'start': {
      const r = deps.runner.run('launchctl', ['load', '-w', deps.unitPath]);
      return finishDarwin('started', r, deps);
    }
    case 'stop': {
      const r = deps.runner.run('launchctl', ['unload', deps.unitPath]);
      return finishDarwin('stopped', r, deps);
    }
    case 'restart': {
      const unload = deps.runner.run('launchctl', ['unload', deps.unitPath]);
      // unload may fail if not loaded — keep going either way.
      if (unload.status !== 0) {
        deps.stderr.write(
          `warning: launchctl unload returned ${unload.status}: ${(unload.stderr || unload.stdout).trim()}\n`,
        );
      }
      const load = deps.runner.run('launchctl', ['load', '-w', deps.unitPath]);
      return finishDarwin('restarted', load, deps);
    }
  }
}

function finishDarwin(
  past: string,
  r: { status: number | null; stdout: string; stderr: string },
  deps: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream },
): RunLifecycleResult {
  if (r.status !== 0) {
    const detail = (r.stderr || r.stdout).trim();
    deps.stderr.write(`error: launchctl returned ${r.status}: ${detail}\n`);
    return { ok: false, status: r.status, message: detail };
  }
  deps.stdout.write(`Service ${past}. Run: hivectl service status\n`);
  return { ok: true, status: r.status, message: '' };
}
