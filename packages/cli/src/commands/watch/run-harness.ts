// `hivectl watch --session-name <n> --session-description <d> --exec <program>`
// (ADR-026 3.b, tech spec § "watch: modo harness"). One named session for a
// harness that runs `claude -p` children:
//   1. registers once with the enrollment credential (or renews the persisted
//      token of the name when this process takes its lock);
//   2. writes the harness state file (0600, atomic) before any child runs;
//   3. holds the stream of the session's mailbox, with its lease;
//   4. renews at half the token's life and rewrites the state file each time
//      (children on the previous copy keep working until its exp and re-read it);
//   5. runs one child per event, through the `--exec` dispatcher of `watch`;
//   6. on a signal or an error, closes the stream and deletes the state file.
// Children reach Hive through the proxy in harness mode: they never see the
// enrollment credential or a Worker token in their environment.

import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  AuthRetryWindow,
  DEFAULT_BACKOFF,
  abortableSleep,
  backoffDelay,
  checkUnread,
  serializeEventLine,
} from '@hive/client';
import type { LogEntry } from '@hive/client';
import { HIVE_VERSION } from '@hive/shared';

import { EXIT_INTERRUPTED } from '#error/exit-codes.js';
import { currentHivectlCommand } from '#commands/claude/plugin.js';
import type { HivectlCommand } from '#commands/claude/plugin.js';
import { isRetryableFailure, SessionRegistration } from '#session/registration.js';
import type { Registered, RegistrationOutcome } from '#session/registration.js';
import {
  configRoot,
  ensurePrivateDir,
  projectKey,
  readPrivateJson,
  removePrivateFile,
  statePaths,
  writePrivateJson,
} from '#session/state-dir.js';
import type { StatePaths } from '#session/state-dir.js';
import { createSessionStream } from '#session/stream.js';
import { openTokenSlot } from '#session/token-store.js';
import { Upstream } from '#session/upstream.js';
import type { SessionFailure } from '#session/upstream.js';

import { readCredential } from './credential.js';
import { createDispatcher } from './dispatcher.js';
import { WatchError } from './errors.js';
import { createExecRunner } from './exec-runner.js';
import type { WatchIo } from './io.js';
import type { HarnessInput } from './session-input.js';

export interface HarnessIo extends WatchIo {
  cwd: string;
  home: string;
}

export interface HarnessOverrides {
  /** Lower bound of the delay before a renewal (tests use short TTLs). */
  renewFloorMs?: number;
  /** The command written into the generated MCP config. */
  hivectl?: HivectlCommand;
}

const RENEW_FLOOR_MS = 1_000;

/** `state/harness/<id>.json`: what a child's proxy needs, and nothing more. */
export interface HarnessState {
  version: 1;
  serverUrl: string;
  agentRef: string;
  agentId: string;
  token: string;
  expiresAt: string;
  watchPid: number;
}

function parseEnrollment(raw: unknown): { serverUrl: string; credential: string } | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const { serverUrl, credential } = raw as Record<string, unknown>;
  if (typeof serverUrl !== 'string' || serverUrl === '') return undefined;
  if (typeof credential !== 'string' || credential === '') return undefined;
  return { serverUrl, credential };
}

function stateError(err: unknown): WatchError {
  const message = err instanceof Error ? err.message : String(err);
  return new WatchError('WATCH_STATE_FILE_INSECURE', message, { cause: err });
}

function resolveEnrollment(
  input: HarnessInput,
  paths: StatePaths,
  key: string,
): { serverUrl: string; credential: string } {
  let saved: { serverUrl: string; credential: string } | undefined;
  try {
    saved = parseEnrollment(readPrivateJson(paths.enrollment(key)));
  } catch (err) {
    throw stateError(err);
  }
  const credential =
    input.credentialFile !== undefined ? readCredential(input.credentialFile) : saved?.credential;
  if (credential === undefined) {
    throw new WatchError(
      'WATCH_CREDENTIAL_MISSING',
      'this folder has no Hive enrollment: run `hivectl claude install` here or pass --credential-file with an enrollment credential',
    );
  }
  const serverUrl = input.server ?? saved?.serverUrl;
  if (serverUrl === undefined) {
    throw new WatchError(
      'WATCH_SERVER_URL_MISSING',
      'no server URL: pass --server <url> or run `hivectl claude install` in this folder',
    );
  }
  return { serverUrl, credential };
}

/** A failure that a retry cannot fix, as the error `watch` ends with. */
function terminal(failure: SessionFailure): WatchError | undefined {
  const detail = `${failure.code}: ${failure.message}`;
  switch (failure.code) {
    case 'name_in_use':
      return new WatchError(
        'WATCH_SESSION_NAME_IN_USE',
        `another live session holds this name (${detail}); wait for its lease to expire or run \`hivectl agent release\``,
      );
    case 'name_taken':
    case 'agent_suspended':
    case 'enrollment_quota_exceeded':
    case 'forbidden':
    case 'invalid_input':
    case 'description_unknown':
      return new WatchError('WATCH_SESSION_REGISTER_REJECTED', detail);
    case 'protocol_unsupported':
    case 'server_mismatch':
      return new WatchError('WATCH_PROTOCOL_UNSUPPORTED', failure.message);
    case 'session_state_insecure_perms':
    case 'session_state_invalid':
      return new WatchError('WATCH_STATE_FILE_INSECURE', failure.message);
    case 'not_installed':
      return new WatchError('WATCH_CREDENTIAL_MISSING', failure.message);
    default:
      return isRetryableFailure(failure.code) || failure.code === 'auth_rejected'
        ? undefined
        : new WatchError('WATCH_SESSION_REGISTER_REJECTED', detail);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** State files of `watch` processes that died without cleaning up (kill -9). */
function removeOrphanStates(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.json') || name.endsWith('.mcp.json')) continue;
    const path = join(dir, name);
    try {
      const pid = (readPrivateJson(path) as { watchPid?: unknown } | undefined)?.watchPid;
      if (typeof pid === 'number' && pid !== process.pid && !isAlive(pid)) {
        removePrivateFile(path);
        removePrivateFile(mcpConfigPathOf(path));
      }
    } catch {
      // Not ours to judge: leave it.
    }
  }
}

export function mcpConfigPathOf(statePath: string): string {
  return statePath.endsWith('.json')
    ? `${statePath.slice(0, -'.json'.length)}.mcp.json`
    : `${statePath}.mcp.json`;
}

export async function runHarness(
  input: HarnessInput,
  io: HarnessIo,
  overrides: HarnessOverrides = {},
): Promise<number> {
  const paths = statePaths(configRoot(io.env, io.home));
  let key: string;
  try {
    key = projectKey(io.cwd);
  } catch {
    throw new WatchError('WATCH_INVALID_OPTION', `cannot resolve the folder ${io.cwd}`);
  }
  const { serverUrl, credential } = resolveEnrollment(input, paths, key);
  const secrets = new Set<string>([credential]);
  const scrub = (text: string): string => {
    let out = text;
    for (const secret of secrets) out = out.split(secret).join('[redacted]');
    return out;
  };
  const diag = (entry: LogEntry): void => {
    io.stderr(`${scrub(JSON.stringify({ ts: new Date().toISOString(), ...entry }))}\n`);
  };
  const backoff = io.backoff ?? DEFAULT_BACKOFF;

  const usesDefaultDir = input.stateFile === undefined;
  const statePath = input.stateFile ?? paths.harnessFile(randomBytes(12).toString('hex'));
  const mcpConfigPath = input.inlineMcpConfig ? mcpConfigPathOf(statePath) : undefined;
  try {
    ensurePrivateDir(dirname(statePath));
  } catch (err) {
    throw stateError(err);
  }
  if (usesDefaultDir) removeOrphanStates(paths.harnessDir);

  const stop = new AbortController();
  const onOuterAbort = (): void => stop.abort();
  if (io.signal.aborted) stop.abort();
  else io.signal.addEventListener('abort', onOuterAbort, { once: true });
  let fatal: WatchError | undefined;
  const fail = (err: WatchError): void => {
    fatal ??= err;
    stop.abort();
  };

  const upstream = new Upstream({
    url: serverUrl,
    clientVersion: HIVE_VERSION,
    probeTimeoutMs: input.probeTimeoutMs,
  });
  const registration: SessionRegistration = new SessionRegistration({
    serverUrl,
    now: () => Date.now(),
    enrollmentCredential: () => credential,
    callRegister: async (bearer, args) => {
      if (!upstream.isDiscovered) {
        const discovered = await upstream.discover(credential);
        if (!discovered.ok) return discovered;
      }
      return upstream.registerSession(bearer, args);
    },
    openSlot: (name) => openTokenSlot(paths, key, name),
    leave: () => stream.stop(),
  });

  const stream = createSessionStream({
    url: serverUrl,
    clientVersion: HIVE_VERSION,
    probeTimeoutMs: input.probeTimeoutMs,
    silenceTimeoutMs: input.silenceTimeoutMs,
    backoff,
    token: () => registration.current?.token,
    onEvent: (event) => dispatcher.handle(event),
    onConnected: () => undefined,
    onAuthRejected: () => void recover(),
    onFatal: (message) => fail(new WatchError('WATCH_PROTOCOL_UNSUPPORTED', message)),
    log: diag,
  });

  const writeState = (registered: Registered): void => {
    secrets.add(registered.token);
    const state: HarnessState = {
      version: 1,
      serverUrl,
      agentRef: registered.agentRef,
      agentId: registered.agentId,
      token: registered.token,
      expiresAt: registered.expiresAt.toISOString(),
      watchPid: process.pid,
    };
    writePrivateJson(statePath, state);
  };

  /** Runs a registration step until it succeeds, a terminal failure or the auth window ends. */
  const untilRegistered = async (
    step: () => Promise<RegistrationOutcome>,
  ): Promise<Registered | undefined> => {
    const window = new AuthRetryWindow(input.authRetryMaxMs, () => Date.now());
    for (let attempt = 0; !stop.signal.aborted; attempt += 1) {
      const outcome = await step();
      if (outcome.ok) return outcome.registered;
      const end = terminal(outcome);
      if (end !== undefined) throw end;
      let wait = backoffDelay(attempt, backoff, () => Math.random());
      if (outcome.code === 'enrollment_rejected' || outcome.code === 'auth_rejected') {
        const verdict = window.reject();
        if (verdict.giveUp) {
          throw new WatchError(
            'WATCH_CREDENTIAL_REJECTED',
            `the server kept rejecting the enrollment credential for ${String(input.authRetryMaxMs / 1000)} seconds`,
          );
        }
        wait = Math.min(wait, verdict.remainingMs);
      }
      diag({ event: 'watch.register_failed', code: outcome.code, retryInMs: wait });
      await abortableSleep(wait, stop.signal);
    }
    return undefined;
  };

  let renewTimer: NodeJS.Timeout | undefined;
  let renewFailures = 0;
  const clearRenewal = (): void => {
    if (renewTimer !== undefined) clearTimeout(renewTimer);
    renewTimer = undefined;
  };
  const scheduleRenewal = (delayMs?: number): void => {
    clearRenewal();
    const current = registration.current;
    if (current === undefined || stop.signal.aborted) return;
    const half = (current.expiresAt.getTime() - Date.now()) / 2;
    const floor = overrides.renewFloorMs ?? RENEW_FLOOR_MS;
    renewTimer = setTimeout(() => void renewNow(), delayMs ?? Math.max(floor, half));
  };
  const adopt = (registered: Registered): void => {
    try {
      writeState(registered);
    } catch (err) {
      fail(stateError(err));
      return;
    }
    renewFailures = 0;
    scheduleRenewal();
  };

  let recovering: Promise<void> | undefined;
  const recover = (): Promise<void> => {
    recovering ??= (async () => {
      clearRenewal();
      try {
        const renewed = await registration.renew();
        let registered: Registered | undefined;
        if (renewed.ok) registered = renewed.registered;
        else if (renewed.code === 'auth_rejected' || renewed.code === 'not_registered') {
          registered = await untilRegistered(() => registration.reenroll());
        } else {
          registered = await untilRegistered(() => registration.renew());
        }
        if (registered === undefined) return;
        adopt(registered);
        if (!stream.running) stream.start();
      } catch (err) {
        fail(
          err instanceof WatchError
            ? err
            : new WatchError('WATCH_CREDENTIAL_REJECTED', String(err)),
        );
      }
    })().finally(() => {
      recovering = undefined;
    });
    return recovering;
  };

  const renewNow = async (): Promise<void> => {
    const renewed = await registration.renew();
    if (renewed.ok) {
      adopt(renewed.registered);
      return;
    }
    if (renewed.code === 'auth_rejected') {
      await recover();
      return;
    }
    diag({ event: 'watch.renew_failed', code: renewed.code });
    scheduleRenewal(backoffDelay(renewFailures++, backoff, () => Math.random()));
  };

  const exec = createExecRunner({
    program: input.exec.program,
    args: input.exec.args,
    baseEnv: io.env,
    secrets: () => [...secrets],
    extraEnv: () => ({
      HIVE_HARNESS_SESSION: statePath,
      ...(mcpConfigPath !== undefined && { HIVE_MCP_CONFIG_FILE: mcpConfigPath }),
    }),
    stopTimeoutMs: input.execStopTimeoutMs,
    stderr: (text) => io.stderr(scrub(text)),
  });
  const dispatcher = createDispatcher(
    {
      signal: stop.signal,
      execMaxRetries: input.execMaxRetries,
      authRetryMaxMs: input.authRetryMaxMs,
      backoff,
    },
    {
      emit: (event) => io.stdout(`${serializeEventLine(event)}\n`),
      exec: (event) => exec(event, stop.signal),
      requery: () =>
        checkUnread({
          url: serverUrl,
          credential: registration.current?.token ?? '',
          probeTimeoutMs: input.probeTimeoutMs,
          clientVersion: HIVE_VERSION,
        }),
      sleep: abortableSleep,
      now: () => Date.now(),
      random: () => Math.random(),
      log: diag,
      onFatal: fail,
    },
  );

  const ended = new Promise<void>((resolve) => {
    if (stop.signal.aborted) resolve();
    else stop.signal.addEventListener('abort', () => resolve(), { once: true });
  });

  try {
    const registered = await untilRegistered(() =>
      registration.register({ name: input.name, description: input.description }),
    );
    if (registered !== undefined) {
      try {
        writeState(registered);
        if (mcpConfigPath !== undefined) {
          const hivectl = overrides.hivectl ?? currentHivectlCommand();
          writePrivateJson(mcpConfigPath, {
            mcpServers: {
              hive: {
                command: hivectl.command,
                args: [...hivectl.args, 'mcp', 'proxy'],
                env: { HIVE_HARNESS_SESSION: statePath },
              },
            },
          });
        }
      } catch (err) {
        throw stateError(err);
      }
      diag({
        event: 'watch.session_registered',
        name: registered.name,
        agentRef: registered.agentRef,
      });
      scheduleRenewal();
      stream.start();
      await ended;
    }
  } catch (err) {
    fail(
      err instanceof WatchError
        ? err
        : new WatchError('WATCH_SESSION_REGISTER_REJECTED', String(err)),
    );
  } finally {
    stop.abort();
    clearRenewal();
    io.signal.removeEventListener('abort', onOuterAbort);
    await stream.stop().catch(() => undefined);
    await recovering?.catch(() => undefined);
    await dispatcher.idle();
    removePrivateFile(statePath);
    if (mcpConfigPath !== undefined) removePrivateFile(mcpConfigPath);
    registration.drop();
  }

  if (fatal !== undefined) throw fatal;
  return EXIT_INTERRUPTED;
}
