// `hivectl watch`: one outbound stream, a metadata line per event, optional
// `--exec`. Persists nothing, never reads message bodies.

import {
  abortableSleep,
  checkUnread,
  createRuntimeDeps,
  createSdkConnector,
  isListenError,
  runListenLoop,
  serializeEventLine,
} from '@hive/client';
import { HIVE_VERSION } from '@hive/shared';

import { EXIT_INTERRUPTED, EXIT_OK } from '#error/exit-codes.js';

import { readCredential } from './credential.js';
import { createDispatcher } from './dispatcher.js';
import { WatchError } from './errors.js';
import { createExecRunner } from './exec-runner.js';
import type { WatchInput } from './input.js';
import { createDiagnostics } from './io.js';
import type { WatchIo } from './io.js';

export async function runWatch(input: WatchInput, io: WatchIo): Promise<number> {
  const credential = readCredential(input.credentialFile);
  const diag = createDiagnostics(io, credential);
  const stop = new AbortController();
  const onOuterAbort = (): void => stop.abort();
  if (io.signal.aborted) stop.abort();
  else io.signal.addEventListener('abort', onOuterAbort, { once: true });

  let fatal: WatchError | undefined;
  const clientOptions = {
    url: input.server,
    credential,
    probeTimeoutMs: input.probeTimeoutMs,
    clientVersion: HIVE_VERSION,
  };

  const exec = input.exec
    ? createExecRunner({
        program: input.exec.program,
        args: input.exec.args,
        baseEnv: io.env,
        secrets: () => [credential],
        stopTimeoutMs: input.execStopTimeoutMs,
        stderr: (text) => io.stderr(text),
      })
    : undefined;

  const dispatcher = createDispatcher(
    {
      signal: stop.signal,
      execMaxRetries: input.execMaxRetries,
      authRetryMaxMs: input.authRetryMaxMs,
      ...(io.backoff ? { backoff: io.backoff } : {}),
    },
    {
      emit: (event) => io.stdout(`${serializeEventLine(event)}\n`),
      exec: exec ? (event) => exec(event, stop.signal) : undefined,
      requery: () => checkUnread(clientOptions),
      sleep: abortableSleep,
      now: () => Date.now(),
      random: () => Math.random(),
      log: diag,
      onFatal: (err) => {
        fatal ??= err;
        stop.abort();
      },
    },
  );

  const connect = createSdkConnector({
    ...clientOptions,
    silenceTimeoutMs: input.silenceTimeoutMs,
  });
  try {
    await runListenLoop(
      {
        signal: stop.signal,
        authRetryMaxMs: input.authRetryMaxMs,
        onEvent: (event) => dispatcher.handle(event),
        ...(io.backoff ? { backoff: io.backoff } : {}),
      },
      createRuntimeDeps(connect, diag),
    );
  } catch (err) {
    stop.abort();
    await dispatcher.idle();
    if (isListenError(err) && err.kind === 'auth_rejected') {
      throw new WatchError(
        'WATCH_CREDENTIAL_REJECTED',
        `the server kept rejecting the credential for ${String(input.authRetryMaxMs / 1000)} seconds`,
        { cause: err },
      );
    }
    throw err;
  } finally {
    io.signal.removeEventListener('abort', onOuterAbort);
  }

  await dispatcher.idle();
  if (fatal !== undefined) throw fatal;
  return io.signal.aborted ? EXIT_INTERRUPTED : EXIT_OK;
}
