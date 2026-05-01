// Thin sync-process abstraction shared by `service install/uninstall/start/
// stop/restart/status`. Wraps `child_process.spawnSync` behind a stable
// interface so handlers can be unit-tested with a mocked runner.

import { spawnSync } from 'node:child_process';

export interface ProcessResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface ProcessRunner {
  run(command: string, args: readonly string[]): ProcessResult;
}

export const realProcessRunner: ProcessRunner = {
  run(command, args) {
    const r = spawnSync(command, [...args], { encoding: 'utf8' });
    return {
      status: r.status,
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
    };
  },
};
