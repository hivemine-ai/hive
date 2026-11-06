// Entry of the Hive wake mod (ADR-026 3.a, waker). It wires the controller to
// the Claude Code host: `$.process` runs `hivectl watch --attach-session`, which
// reads the session's single stream from its local proxy; `$.prompt.submit`
// starts turns; `$.ui.toast` tells the user when watch cannot run. Turns of
// subagents are ignored: only the main loop's turns decide whether the session
// is busy.
//
// Rules from the PRY-089 spike (Claude Code 2.1.318):
//  - `session.start` does not fire again after /clear or /resume: the mod
//    retargets its watch to the `e.session_id` of `classic.SessionStart`;
//  - inside `classic.SessionStart`, `$.session.id()` may still return the
//    previous id: the mod only uses `e.session_id` there;
//  - with the harness marker (a `claude -p` child of `hivectl watch`) the mod
//    launches nothing: the presence belongs to the harness.
// The PID map and the session mapping are written by the command hooks, not here.

import { createController } from './controller.js';
import { HIVECTL } from './hivectl-path.js';

/**
 * The slice of the host's `$` this mod uses. The full declarations are written
 * by Claude Code into `.claude-plugin/types/` when it loads the mod.
 * @typedef {object} Dollar
 * @property {{
 *   spawn(request: { argv: readonly string[] }): import('./controller.js').SpawnedProcess,
 *   run(argv: readonly string[], init?: { timeoutMs?: number }): Promise<{ exitCode: number, stdout: string, stderr: string }>,
 * }} process
 * @property {{ submit(args: { text: string }): Promise<{ drop?: string } | void> }} prompt
 * @property {{ toast(text: string, options?: { timeoutMs?: number }): void }} ui
 * @property {{ id(): string | undefined | Promise<string | undefined> }} session
 * @property {{ get(name: string): string | undefined | Promise<string | undefined> }} env
 *
 * @typedef {{ agentId?: string, session_id?: string, source?: string, reason?: string }} HookEvent
 * @typedef {(event: HookEvent) => Promise<unknown>} Next
 * @typedef {($: Dollar, event: HookEvent, next: Next) => unknown} Handler
 */

/** Session ends that keep the same process and session loop: a new id follows. */
const CONTINUING_ENDS = new Set(['clear', 'resume']);

/** @param {Dollar} $ */
async function isHarnessChild($) {
  try {
    const marker = await $.env.get('HIVE_HARNESS_SESSION');
    return typeof marker === 'string' && marker !== '';
  } catch {
    return false;
  }
}

/**
 * The host services the controller needs, bound to this `$`.
 * @param {Dollar} $
 * @returns {import('./controller.js').Host}
 */
function hostOf($) {
  return {
    spawn: (argv) => $.process.spawn({ argv }),
    run: (argv) => $.process.run(argv, { timeoutMs: 30_000 }),
    submit: (text) => $.prompt.submit({ text }),
    toast: (text) => $.ui.toast(text, { timeoutMs: 15_000 }),
    sleep: (ms) =>
      new Promise((resolve) => {
        const timer = /** @type {{ unref?: () => void }} */ (globalThis.setTimeout(resolve, ms));
        timer.unref?.();
      }),
    now: () => Date.now(),
  };
}

/**
 * @param {(event: string, handler: Handler) => void} on
 */
export function register(on) {
  /** @type {ReturnType<typeof createController> | undefined} */
  let controller;

  /** @param {import('./controller.js').Host} host @param {string} sessionId */
  const follow = (host, sessionId) => {
    if (controller === undefined) {
      controller = createController({ options: { hivectl: HIVECTL, sessionId }, host });
    } else {
      controller.retarget(sessionId);
    }
    controller.start();
  };

  on('session.start', async ($, e, next) => {
    const started = await next(e);
    if (!(await isHarnessChild($))) {
      let sessionId;
      try {
        sessionId = await $.session.id();
      } catch {
        sessionId = undefined;
      }
      if (typeof sessionId === 'string' && sessionId !== '') follow(hostOf($), sessionId);
    }
    return started;
  });

  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e);
    const sessionId = e.session_id;
    if (typeof sessionId === 'string' && sessionId !== '' && !(await isHarnessChild($))) {
      follow(hostOf($), sessionId);
    }
    return result;
  });

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) controller?.onTurnStart();
    return next(e);
  });

  on('turn.complete', async ($, e, next) => {
    const result = await next(e);
    if (e.agentId === undefined) controller?.onTurnComplete();
    return result;
  });

  on('session.end', async ($, e, next) => {
    if (!CONTINUING_ENDS.has(String(e.reason ?? ''))) {
      const ended = controller;
      controller = undefined;
      await ended?.stop();
    }
    return next(e);
  });
}
