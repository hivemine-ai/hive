// Entry of the Hive wake mod. It wires the controller to the Claude Code host:
// `$.process` runs `hivectl watch`, `$.prompt.submit` starts turns, `$.ui.toast`
// tells the user when watch cannot run. Turns of subagents are ignored: only the
// main loop's turns decide whether the session is busy.

import { createController } from './controller.js';

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
 *
 * @typedef {{ agentId?: string }} HookEvent
 * @typedef {(event: HookEvent) => Promise<unknown>} Next
 * @typedef {($: Dollar, event: HookEvent, next: Next) => unknown} Handler
 */

/**
 * @param {(event: string, handler: Handler) => void} on
 * @param {Readonly<Record<string, string | number | boolean | readonly string[]>>} options
 */
export function register(on, options) {
  /** @type {ReturnType<typeof createController> | undefined} */
  let controller;

  on('session.start', async ($, e, next) => {
    const started = await next(e);
    controller ??= createController({
      options: {
        hivectl: String(options['hivectl_path'] ?? 'hivectl'),
        server: String(options['server_url'] ?? ''),
        credentialFile: String(options['credential_file'] ?? ''),
      },
      host: {
        spawn: (argv) => $.process.spawn({ argv }),
        run: (argv) => $.process.run(argv, { timeoutMs: 30_000 }),
        submit: (text) => $.prompt.submit({ text }),
        toast: (text) => $.ui.toast(text, { timeoutMs: 15_000 }),
        sleep: (ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms)),
        now: () => Date.now(),
      },
    });
    if (String(options['server_url'] ?? '') === '') {
      $.ui.toast('Hive wake: set the server_url option so hivectl watch knows where to connect.');
    } else {
      controller.start();
    }
    return started;
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
    await controller?.stop();
    return next(e);
  });
}
