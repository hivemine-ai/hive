// Runs the `--exec` command for one event. argv goes straight to the program with
// no shell. The event line travels on stdin and, redundantly, as three env vars;
// no text from a third party ever reaches argv.
//
// The child never inherits a secret of `watch`: every HIVE_WATCH_* variable and
// every variable whose value contains one of the secrets (the credential of a
// classic watch; the enrollment credential and the Worker tokens of a harness) is
// dropped, whatever its name. Claude Code does not filter the environment of its
// stdio servers and hooks (PRY-089, test 7), so this is the only filter.

import { spawn } from 'node:child_process';

import { serializeEventLine } from '@hive/client';
import type { WatchEvent } from '@hive/client';

export interface ExecRunnerOptions {
  program: string;
  args: string[];
  baseEnv: NodeJS.ProcessEnv;
  /** Read per run: dropped from the child environment wherever one appears in a value. */
  secrets(): readonly string[];
  /** Read per run: variables `watch` sets for the child (the harness marker). */
  extraEnv?(): Record<string, string>;
  /** How long to wait for a running child once `watch` is told to stop. */
  stopTimeoutMs: number;
  /** Receives everything the child writes, so stdout stays clean. */
  stderr: (text: string) => void;
}

const KILL_GRACE_MS = 5000;

/** Set only by `watch` itself, never inherited. */
const OWN_VARIABLES = new Set(['HIVE_HARNESS_SESSION', 'HIVE_MCP_CONFIG_FILE']);

export function buildChildEnv(
  baseEnv: NodeJS.ProcessEnv,
  event: WatchEvent,
  secrets: readonly string[],
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const live = secrets.filter((s) => s !== '');
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined || key.startsWith('HIVE_WATCH_') || OWN_VARIABLES.has(key)) continue;
    if (live.some((secret) => value.includes(secret))) continue;
    env[key] = value;
  }
  Object.assign(env, extra);
  env['HIVE_EVENT_ID'] = event.eventId;
  env['HIVE_EVENT_SENDERS'] = event.senders.join(',');
  env['HIVE_EVENT_COUNT'] = String(event.count);
  return env;
}

export function createExecRunner(
  options: ExecRunnerOptions,
): (event: WatchEvent, signal: AbortSignal) => Promise<number> {
  return (event, signal) =>
    new Promise<number>((resolve, reject) => {
      const child = spawn(options.program, options.args, {
        env: buildChildEnv(options.baseEnv, event, options.secrets(), options.extraEnv?.() ?? {}),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      });
      let settled = false;
      const timers: NodeJS.Timeout[] = [];
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        for (const t of timers) clearTimeout(t);
        signal.removeEventListener('abort', onAbort);
        fn();
      };

      const onAbort = (): void => {
        timers.push(
          setTimeout(() => {
            child.kill('SIGTERM');
            timers.push(setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS));
          }, options.stopTimeoutMs),
        );
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (chunk: Buffer) => options.stderr(chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => options.stderr(chunk.toString('utf8')));
      child.stdin.on('error', () => {});
      child.stdin.end(`${serializeEventLine(event)}\n`);
      child.on('error', (err) => finish(() => reject(err)));
      child.on('close', (code, sig) => finish(() => resolve(code ?? (sig ? 128 : 1))));
    });
}
