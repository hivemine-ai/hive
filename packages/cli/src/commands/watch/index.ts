// Registers `hivectl watch`. Unlike the rest of the catalog it is a network
// client of the Hive MCP server: no database, no runtime, no operator trust
// anchor. It authenticates as the participant that owns the credential file.

import { homedir } from 'node:os';

import type { Command } from 'commander';

import { EXIT_INTERRUPTED } from '#error/exit-codes.js';

import { mapWatchError } from './errors.js';
import { resolveWatchInput } from './input.js';
import { runWatchOnce } from './run-once.js';
import { runWatch } from './run-watch.js';
import { runAttach } from './run-attach.js';
import { runHarness } from './run-harness.js';
import { isSessionMode, resolveSessionWatchInput } from './session-input.js';

export interface WatchCommandHooks {
  setExitCode(code: number): void;
}

interface WatchCliOptions {
  server?: string;
  credentialFile?: string;
  exec?: string;
  once?: boolean;
  silenceTimeout?: string;
  probeTimeout?: string;
  sessionName?: string;
  sessionDescription?: string;
  stateFile?: string;
  inlineMcpConfig?: boolean;
  attachSession?: string;
}

/** SIGINT and SIGTERM abort once; a second signal forces the exit. */
function installSignalAbort(): { signal: AbortSignal; teardown: () => void } {
  const controller = new AbortController();
  let pressed = 0;
  const onSignal = (): void => {
    pressed += 1;
    if (pressed === 1) controller.abort();
    else process.exit(EXIT_INTERRUPTED);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  return {
    signal: controller.signal,
    teardown: () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    },
  };
}

export function registerWatchCommand(program: Command, hooks: WatchCommandHooks): void {
  program
    .command('watch')
    .description(
      'Listen to the mailbox of one participant and print a metadata line per event. ' +
        'Never prints message bodies.',
    )
    .option('--server <url>', 'Hive MCP endpoint (default: $HIVE_WATCH_SERVER_URL)')
    .option(
      '--credential-file <path>',
      'file holding the participant credential, mode 0600 (default: $HIVE_WATCH_CREDENTIAL_FILE)',
    )
    .option('--exec <program>', 'run this program once per event (no shell); arguments follow `--`')
    .option('--once', 'check unread messages once, print one line if any, and exit')
    .option(
      '--silence-timeout <seconds>',
      'reconnect after this long without any byte (default 45)',
    )
    .option('--probe-timeout <seconds>', 'timeout of the connectivity probe, below 60 (default 20)')
    .option(
      '--session-name <name>',
      'harness mode: register this named session with the folder enrollment and run --exec children',
    )
    .option('--session-description <text>', 'harness mode: one-line description of the session')
    .option('--state-file <path>', 'harness mode: where to write the state file of the children')
    .option(
      '--inline-mcp-config',
      'harness mode: also write an MCP config for `claude -p --mcp-config "$HIVE_MCP_CONFIG_FILE"`',
    )
    .option(
      '--attach-session <session_id>',
      'consume the stream of the proxy of this Claude Code session (launched by the hive-wake plugin)',
    )
    .argument('[exec-args...]', 'arguments for the --exec program, after `--`')
    .action(async (execArgs: string[], opts: WatchCliOptions) => {
      const signals = installSignalAbort();
      try {
        const raw = {
          ...(opts.server !== undefined ? { server: opts.server } : {}),
          ...(opts.credentialFile !== undefined ? { credentialFile: opts.credentialFile } : {}),
          ...(opts.exec !== undefined ? { exec: opts.exec } : {}),
          ...(opts.once !== undefined ? { once: opts.once } : {}),
          ...(opts.silenceTimeout !== undefined ? { silenceTimeout: opts.silenceTimeout } : {}),
          ...(opts.probeTimeout !== undefined ? { probeTimeout: opts.probeTimeout } : {}),
          ...(opts.sessionName !== undefined ? { sessionName: opts.sessionName } : {}),
          ...(opts.sessionDescription !== undefined
            ? { sessionDescription: opts.sessionDescription }
            : {}),
          ...(opts.stateFile !== undefined ? { stateFile: opts.stateFile } : {}),
          ...(opts.inlineMcpConfig !== undefined ? { inlineMcpConfig: opts.inlineMcpConfig } : {}),
          ...(opts.attachSession !== undefined ? { attachSession: opts.attachSession } : {}),
          execArgs,
        };
        const io = {
          stdout: (text: string) => void process.stdout.write(text),
          stderr: (text: string) => void process.stderr.write(text),
          env: process.env,
          signal: signals.signal,
        };
        let code: number;
        if (isSessionMode(raw)) {
          const input = resolveSessionWatchInput(raw, process.env);
          const sessionIo = { ...io, cwd: process.cwd(), home: homedir() };
          code =
            input.kind === 'harness'
              ? await runHarness(input, sessionIo)
              : await runAttach(input, sessionIo);
        } else {
          const input = resolveWatchInput(raw, process.env);
          code = input.once ? await runWatchOnce(input, io) : await runWatch(input, io);
        }
        hooks.setExitCode(code);
      } catch (err) {
        const mapped = mapWatchError(err);
        process.stderr.write(`error: ${mapped.message}\n`);
        hooks.setExitCode(mapped.code);
      } finally {
        signals.teardown();
      }
    });
}
