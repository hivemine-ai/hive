// Process-wide signal handler that converts SIGINT/SIGTERM to a cancellation
// via AbortController. Long-running commands (like `audit stream` in Slice 1+)
// propagate the signal; short-lived commands ignore it.

import type { Logger } from '@hive/server';

import { EXIT_INTERNAL } from '#error/exit-codes.js';

let abortController: AbortController = new AbortController();
let installed = false;
let pressed = 0;

export interface SignalHandlerHandle {
  /** AbortSignal that fires on the first SIGINT/SIGTERM. */
  signal: AbortSignal;
  /** Tear down the listeners — used by tests to keep the global state clean. */
  teardown(): void;
}

export function setupSignalHandlers(logger: Logger): SignalHandlerHandle {
  if (installed) {
    return { signal: abortController.signal, teardown: noopTeardown };
  }
  installed = true;
  const onSignal = (sig: NodeJS.Signals): void => {
    pressed++;
    if (pressed === 1) {
      logger.warn(
        { event: 'interrupt_received', signal: sig },
        `received ${sig}; cancelling current operation. Press again to force-exit.`,
      );
      abortController.abort();
    } else {
      logger.error({ event: 'interrupt_force_exit', signal: sig }, 'force-exit');
      process.exit(EXIT_INTERNAL);
    }
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  return {
    signal: abortController.signal,
    teardown(): void {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      installed = false;
    },
  };
}

/** Read-only access to the cancellation signal — use inside command handlers. */
export function getAbortSignal(): AbortSignal {
  return abortController.signal;
}

/** Test-only: reset the controller so each test starts clean. */
export function __resetSignalHandlerForTests(): void {
  abortController = new AbortController();
  installed = false;
  pressed = 0;
}

function noopTeardown(): void {
  // Already installed — caller does not own the listener lifecycle.
}
