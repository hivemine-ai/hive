// Registers `hivectl config` as a commander sub-group. Currently a single
// child: `network <local-only | bind-all>`.

import type { Command } from 'commander';

import { mapErrorToExit } from '#error/handler.js';

import { runConfigNetwork } from './network.js';
import type { NetworkMode } from './network.js';

export interface ConfigGroupHooks {
  setExitCode(code: number): void;
}

export function registerConfigGroup(program: Command, hooks: ConfigGroupHooks): void {
  const config = program.command('config').description('Persistent configuration.');

  config
    .command('network <mode>')
    .description("Toggle bind address: 'local-only' (127.0.0.1) | 'bind-all' (0.0.0.0).")
    .action(async (rawMode: string) => {
      try {
        if (rawMode !== 'local-only' && rawMode !== 'bind-all') {
          process.stderr.write(
            `error: mode must be 'local-only' or 'bind-all' (got "${rawMode}")\n`,
          );
          hooks.setExitCode(1);
          return;
        }
        const mode: NetworkMode = rawMode;
        await runConfigNetwork({ mode });
      } catch (err) {
        const mapped = mapErrorToExit(err);
        process.stderr.write(`error: ${mapped.message}\n`);
        hooks.setExitCode(mapped.code);
      }
    });
}
