// Registers `hivectl claude install | uninstall`. Local commands: no database,
// no runtime; they talk to the `claude` CLI and to ~/.config/hive/.

import { homedir } from 'node:os';

import type { Command } from 'commander';
import { HIVE_VERSION } from '@hive/shared';

import { mapErrorToExit } from '#error/handler.js';
import { Upstream } from '#session/upstream.js';

import { runClaudeInstall, runClaudeUninstall } from './install.js';
import type { ClaudeInstallResult, ClaudeUninstallResult } from './install.js';
import { currentHivectlCommand, defaultPluginSearchStarts, findPluginSource } from './plugin.js';

interface Hooks {
  setExitCode(code: number): void;
}

function print(
  value: ClaudeInstallResult | ClaudeUninstallResult,
  json: boolean,
  lines: string[],
): void {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${lines.join('\n')}\n`);
}

function fail(err: unknown, hooks: Hooks): void {
  const mapped = mapErrorToExit(err);
  process.stderr.write(`error: ${mapped.message}\n`);
  hooks.setExitCode(mapped.code);
}

const baseDeps = () => ({
  env: process.env,
  home: homedir(),
  cwd: process.cwd(),
  warn: (message: string) => void process.stderr.write(`warning: ${message}\n`),
  now: () => new Date(),
});

export function registerClaudeCommands(program: Command, hooks: Hooks): void {
  const claude = program
    .command('claude')
    .description(
      'Install Hive into a folder for Claude Code sessions (hive-wake plugin + enrollment).',
    );

  claude
    .command('install')
    .description(
      'Save the Hive URL and an enrollment credential for this folder (in ~/.config/hive, never ' +
        'in the folder) and install the hive-wake plugin with `--scope local`.',
    )
    .option('--server <url>', 'Hive MCP endpoint, for example https://hive.example.com/mcp')
    .option('--enrollment-credential <file>', 'file holding the enrollment credential, mode 0600')
    .option('--project <path>', 'project folder (default: the current directory)')
    .action(
      async (
        opts: { server?: string; enrollmentCredential?: string; project?: string },
        cmd: Command,
      ) => {
        try {
          const result = await runClaudeInstall(
            {
              server: opts.server,
              enrollmentCredential: opts.enrollmentCredential,
              project: opts.project,
            },
            {
              ...baseDeps(),
              hivectl: currentHivectlCommand(),
              pluginSource: () => findPluginSource(defaultPluginSearchStarts()),
              discover: (url, credential) =>
                new Upstream({ url, clientVersion: HIVE_VERSION, probeTimeoutMs: 5_000 }).discover(
                  credential,
                ),
            },
          );
          print(result, cmd.optsWithGlobals<{ output?: string }>().output === 'json', [
            `Hive installed for ${result.project}`,
            `  enrollment (credential): ${result.enrollmentFile}`,
            `  plugin marketplace:      ${result.marketplace}`,
            `  Claude Code settings:    ${result.settingsFile} (no secret)`,
            `  .gitignore:              ${result.gitignore.replaceAll('_', ' ')}`,
            'The enrollment credential stays outside the project folder.',
          ]);
        } catch (err) {
          fail(err, hooks);
        }
      },
    );

  claude
    .command('uninstall')
    .description(
      'Remove the hive-wake plugin and the Hive enrollment of this folder. Does not revoke the ' +
        'credential or the agents. Requires --yes.',
    )
    .option('--project <path>', 'project folder (default: the current directory)')
    .action(async (opts: { project?: string }, cmd: Command) => {
      const globals = cmd.optsWithGlobals<{ yes?: boolean; output?: string }>();
      try {
        const result = await runClaudeUninstall(
          { project: opts.project, yes: globals.yes === true },
          baseDeps(),
        );
        print(result, globals.output === 'json', [
          `Hive removed from ${result.project}`,
          ...result.removed.map((path) => `  removed: ${path}`),
          result.pluginCopyRemoved
            ? '  removed the plugin copy (no folder uses it any more)'
            : '  kept the plugin copy (other folders use it)',
          'The enrollment credential and the agents are not revoked: use `hivectl credential revoke`.',
          'The .gitignore line stays. Running sessions keep their proxy until they end.',
        ]);
      } catch (err) {
        fail(err, hooks);
      }
    });
}
