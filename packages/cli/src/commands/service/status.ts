// `hivectl service status` — runs `systemctl show` (Linux) or `launchctl
// list` (Mac), parses the output, and renders a uniform multi-line summary.
//
// Per the hivectl + Admin Operations tech spec § "service status".
// Exit code: 0 if running, 1 if stopped/error/not-installed (script-friendly).

import { existsSync } from 'node:fs';

import {
  detectPlatform,
  getDefaultUnitPath,
  LAUNCHD_LABEL,
  SYSTEMD_UNIT_NAME,
} from '#platform/detect.js';

import { realProcessRunner } from './exec.js';
import type { ProcessRunner } from './exec.js';
import { parseLaunchctlList, parseSystemctlShow, renderServiceStatus } from './status-parser.js';
import type { ServiceStatus } from './status-parser.js';

export interface RunServiceStatusInput {
  /** N>0 logs to display. Default 0 (only the last log line if running). */
  logs?: number;
}

export interface RunServiceStatusDeps {
  runner?: ProcessRunner;
  unitPath?: string;
  platform?: 'linux' | 'darwin';
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  /** Mac-only — path to the launchd stderr log. */
  macStderrPath?: string;
}

export interface RunServiceStatusResult {
  installed: boolean;
  status: ServiceStatus;
  /** Exit code: 0 if running, 1 otherwise. */
  exitCode: 0 | 1;
}

export function runServiceStatus(
  input: RunServiceStatusInput = {},
  deps: RunServiceStatusDeps = {},
): Promise<RunServiceStatusResult> {
  const platform = deps.platform ?? detectPlatform();
  const runner = deps.runner ?? realProcessRunner;
  const stdout = deps.stdout ?? process.stdout;
  const unitPath =
    deps.unitPath ??
    getDefaultUnitPath(
      platform === 'linux'
        ? { platform: 'linux', homedir: () => '/root', env: process.env }
        : { platform: 'darwin', homedir: () => process.env['HOME'] ?? '/', env: process.env },
    );

  const installed = existsSync(unitPath);
  const supervisor = platform === 'linux' ? 'systemd' : 'launchd';
  if (!installed) {
    const status: ServiceStatus = { state: 'not-installed', pid: null, uptimeMs: null };
    stdout.write(`${renderServiceStatus({ installed: false, supervisor, status })}\n`);
    return Promise.resolve({ installed: false, status, exitCode: 1 });
  }

  let status: ServiceStatus;
  let lastLog: string | undefined;
  let recentLogs: string[] | undefined;
  const logsN = input.logs ?? 0;

  if (platform === 'linux') {
    const r = runner.run('systemctl', [
      'show',
      SYSTEMD_UNIT_NAME,
      '--property=ActiveState,MainPID,ActiveEnterTimestamp',
    ]);
    status = parseSystemctlShow(r.stdout);
    if (status.state === 'running') {
      const journalArgs = ['-u', SYSTEMD_UNIT_NAME, '-n', String(Math.max(logsN, 1)), '--no-pager'];
      const j = runner.run('journalctl', journalArgs);
      const lines = j.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '');
      if (logsN > 0) recentLogs = lines.slice(-logsN);
      else lastLog = lines.length > 0 ? lines[lines.length - 1] : undefined;
    }
  } else {
    const r = runner.run('launchctl', ['list', LAUNCHD_LABEL]);
    status = parseLaunchctlList(r.stdout);
    if (status.state === 'running' && deps.macStderrPath !== undefined) {
      const tailArgs = ['-n', String(Math.max(logsN, 1)), deps.macStderrPath];
      const t = runner.run('tail', tailArgs);
      const lines = t.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '');
      if (logsN > 0) recentLogs = lines.slice(-logsN);
      else lastLog = lines.length > 0 ? lines[lines.length - 1] : undefined;
    }
  }

  const renderInput: Parameters<typeof renderServiceStatus>[0] = {
    installed: true,
    supervisor,
    status,
  };
  if (lastLog !== undefined) renderInput.lastLog = lastLog;
  if (recentLogs !== undefined) renderInput.recentLogs = recentLogs;
  stdout.write(`${renderServiceStatus(renderInput)}\n`);

  return Promise.resolve({
    installed: true,
    status,
    exitCode: status.state === 'running' ? 0 : 1,
  });
}
