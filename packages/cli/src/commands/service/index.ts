// Registers `hivectl service` as a commander sub-group with the 6 lifecycle
// verbs as children: install / uninstall / start / stop / restart / status.
//
// All children share the OS detection helper from `platform/detect.ts` and
// the OS-process abstraction from `exec.ts`. Errors thrown as `CliError` are
// mapped to exit codes by `error/handler.ts`.

import type { Command } from 'commander';

import { mapErrorToExit } from '#error/handler.js';

import type { NetworkMode } from '../config/network.js';

import { renderInstallSuccess, runServiceInstall } from './install.js';
import { runServiceLifecycle } from './lifecycle.js';
import type { LifecycleVerb } from './lifecycle.js';
import { runServiceStatus } from './status.js';
import { runServiceUninstall } from './uninstall.js';

export interface ServiceGroupHooks {
  setExitCode(code: number): void;
}

export function registerServiceGroup(program: Command, hooks: ServiceGroupHooks): void {
  const service = program.command('service').description('Manage the Hive system service.');

  service
    .command('install')
    .description('Install the systemd unit (Linux) or launchd plist (Mac).')
    .option('--user <name>', 'service user (Linux only; default "hive")')
    .option('--working-dir <path>', 'working directory (default per-OS)')
    .option('--bind <mode>', "set bind address: 'local-only' | 'bind-all'")
    .action(async (cmdOpts: Record<string, unknown>) => {
      try {
        const input: Parameters<typeof runServiceInstall>[0] = {};
        if (typeof cmdOpts['user'] === 'string') input.user = cmdOpts['user'];
        if (typeof cmdOpts['workingDir'] === 'string') {
          input.workingDir = cmdOpts['workingDir'];
        }
        const rawBind = cmdOpts['bind'];
        if (typeof rawBind === 'string') {
          if (rawBind !== 'local-only' && rawBind !== 'bind-all') {
            process.stderr.write(`error: --bind must be 'local-only' or 'bind-all'\n`);
            hooks.setExitCode(1);
            return;
          }
          const bind: NetworkMode = rawBind;
          input.bind = bind;
        }
        const result = await runServiceInstall(input);
        process.stdout.write(`${renderInstallSuccess(result)}\n`);
      } catch (err) {
        const mapped = mapErrorToExit(err);
        process.stderr.write(`error: ${mapped.message}\n`);
        hooks.setExitCode(mapped.code);
      }
    });

  service
    .command('uninstall')
    .description('Remove the systemd unit / launchd plist (idempotent; stops first if active).')
    .action(async () => {
      try {
        await runServiceUninstall();
      } catch (err) {
        const mapped = mapErrorToExit(err);
        process.stderr.write(`error: ${mapped.message}\n`);
        hooks.setExitCode(mapped.code);
      }
    });

  for (const verb of ['start', 'stop', 'restart'] as LifecycleVerb[]) {
    const description = {
      start: 'Start the Hive service (delegates to systemctl/launchctl).',
      stop: 'Stop the Hive service (delegates to systemctl/launchctl).',
      restart: 'Restart the Hive service (delegates to systemctl/launchctl).',
    }[verb];
    service
      .command(verb)
      .description(description)
      .action(async () => {
        try {
          const result = await runServiceLifecycle(verb);
          if (!result.ok) hooks.setExitCode(1);
        } catch (err) {
          const mapped = mapErrorToExit(err);
          process.stderr.write(`error: ${mapped.message}\n`);
          hooks.setExitCode(mapped.code);
        }
      });
  }

  service
    .command('status')
    .description('Print uniform service status (script-friendly: exit 0 if running, 1 otherwise).')
    .option('--logs <n>', 'show last N journal/log lines (default 1 if running, else 0)', '0')
    .action(async (cmdOpts: Record<string, unknown>) => {
      try {
        const rawLogs = cmdOpts['logs'];
        let logs: number | undefined;
        if (typeof rawLogs === 'string' && rawLogs !== '') {
          const n = Number(rawLogs);
          if (!Number.isInteger(n) || n < 0) {
            process.stderr.write(
              `error: --logs must be a non-negative integer (got "${rawLogs}")\n`,
            );
            hooks.setExitCode(1);
            return;
          }
          logs = n;
        }
        const result = await runServiceStatus(logs !== undefined ? { logs } : {});
        if (result.exitCode !== 0) hooks.setExitCode(result.exitCode);
      } catch (err) {
        const mapped = mapErrorToExit(err);
        process.stderr.write(`error: ${mapped.message}\n`);
        hooks.setExitCode(mapped.code);
      }
    });
}
