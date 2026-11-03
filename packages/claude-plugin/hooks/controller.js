// The mod's brain, free of any host API so it can be tested in plain Node. The
// register module wires it to `$.process`, `$.prompt` and `$.ui`.
//
// Two jobs:
//  1. keep `hivectl watch` alive and turn each metadata line into a turn;
//  2. keep one flag while a turn is active and, at `turn.complete`, ask
//     `hivectl watch --once` whether anything is still unread.
// There is no queue and no resend: the mailbox is the source of truth.

import { buildPrompt, parseEventLine } from './event-line.js';

const EXIT_USER_ERROR = 1;
const EXIT_PRECONDITION = 4;
const EXIT_INTERRUPTED = 130;
/** Exit codes that retrying cannot fix: the same ones that do not restart watch. */
const ONCE_TERMINAL_EXITS = new Set([EXIT_USER_ERROR, EXIT_PRECONDITION, EXIT_INTERRUPTED]);
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 60_000;
/** A watch that stayed up this long counts as healthy and resets the backoff. */
const HEALTHY_MS = 60_000;
/** Consecutive short-lived runs before the user is warned. */
const CRASH_WARNING_AFTER = 5;
const STDERR_TAIL_CHARS = 4000;
const WATCH_ERROR_LINE = /^error: (WATCH_[A-Z_]+)(?::\s*(.*))?$/m;
/** Idle retry of `--once`: bounded backoff, until the flag clears or a terminal exit. */
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 60_000;

/**
 * @typedef {{ stream: 'stdout' | 'stderr', text: string }} Piece
 * @typedef {{ code: number | null, signal: string | null }} ExitInfo
 * @typedef {{
 *   next(): Promise<IteratorResult<Piece, ExitInfo>>,
 *   return(): Promise<unknown>,
 * }} SpawnedProcess
 * @typedef {{
 *   spawn(argv: readonly string[]): SpawnedProcess,
 *   run(argv: readonly string[]): Promise<{ exitCode: number, stdout: string, stderr: string }>,
 *   submit(text: string): Promise<{ drop?: string } | void>,
 *   toast(text: string): void,
 *   sleep(ms: number): Promise<void>,
 *   now(): number,
 * }} Host
 * @typedef {{ hivectl: string, server: string, credentialFile: string }} Options
 */

/**
 * @param {{ options: Options, host: Host }} deps
 */
export function createController({ options, host }) {
  let started = false;
  let stopped = false;
  let turnActive = false;
  let onceRunning = false;
  /** True from the moment a submit is issued until the host answers. */
  let submitting = false;
  /** Bumped to cancel the idle retry loop. */
  let retryGen = 0;
  let retrying = false;
  /** Set by a terminal `--once` exit: the idle retry stays off until there is news. */
  let onceHalted = false;
  /** One warning per failure episode, however many turns hit the same exit. */
  let onceWarned = false;
  /** Watch stopped for good and said why: `--once` has nothing to add. */
  let watchReported = false;
  let flag = false;
  /** Bumped on every flag raise, so a raise during `--once` is never cleared by it. */
  let flagSeq = 0;
  /** @type {SpawnedProcess | undefined} */
  let child;

  /** `hivectl watch [extra] --server ... [--credential-file ...]` */
  const watchArgv = (/** @type {string[]} */ extra = []) => [
    options.hivectl,
    'watch',
    ...extra,
    '--server',
    options.server,
    ...(options.credentialFile === '' ? [] : ['--credential-file', options.credentialFile]),
  ];

  const raiseFlag = () => {
    flag = true;
    flagSeq += 1;
    ensureRetry();
  };

  const busy = () => turnActive || submitting || onceRunning;

  /**
   * While the flag is set and nothing is running there will be no `turn.complete`
   * to recover it, so retry `--once` with backoff. Cancelled when a turn starts,
   * when the flag clears, or on stop.
   */
  function ensureRetry() {
    if (retrying || stopped || !flag || turnActive || onceHalted) return;
    retrying = true;
    const gen = ++retryGen;
    void (async () => {
      let attempt = 0;
      try {
        while (gen === retryGen && flag && !stopped && !turnActive && !onceHalted) {
          await host.sleep(Math.min(RETRY_MIN_MS * 2 ** attempt, RETRY_MAX_MS));
          attempt += 1;
          if (gen !== retryGen || !flag || stopped || turnActive || onceHalted) break;
          if (submitting || onceRunning) continue;
          await runOnce();
        }
      } finally {
        if (gen === retryGen) retrying = false;
      }
    })();
  }

  function cancelRetry() {
    retryGen += 1;
    retrying = false;
  }

  /** Submits a turn. Resolves true when the host accepted it. */
  async function submitTurn(/** @type {import('./event-line.js').WatchEvent} */ event) {
    if (stopped) return false;
    // Synchronous guard: a second line in the same chunk must see it before the await.
    submitting = true;
    try {
      const result = await host.submit(buildPrompt(event));
      if (result && typeof result === 'object' && result.drop !== undefined) return false;
      turnActive = true;
      cancelRetry();
      return true;
    } catch {
      return false;
    } finally {
      submitting = false;
    }
  }

  async function onWatchLine(/** @type {string} */ raw) {
    const event = parseEventLine(raw.trim());
    if (event === null) return;
    // A live stream is news: whatever stopped `--once` may be gone.
    onceHalted = false;
    if (busy()) {
      raiseFlag();
      return;
    }
    if (!(await submitTurn(event))) raiseFlag();
  }

  async function runOnce() {
    if (onceRunning || !flag) return;
    onceRunning = true;
    const seqAtStart = flagSeq;
    try {
      const result = await host.run(watchArgv(['--once']));
      if (stopped) return;
      if (ONCE_TERMINAL_EXITS.has(result.exitCode)) {
        haltOnce(result);
        return;
      }
      onceHalted = false;
      if (result.exitCode !== 0) return;
      onceWarned = false;
      const lines = result.stdout.split('\n').filter((l) => l.trim() !== '');
      const event = lines.length > 0 ? parseEventLine(/** @type {string} */ (lines[0])) : null;
      if (event !== null) {
        if (!(await submitTurn(event))) return;
      }
      if (flagSeq === seqAtStart) flag = false;
    } catch {
      // Keep the flag: the next turn.complete or event retries.
    } finally {
      onceRunning = false;
      if (flag) ensureRetry();
    }
  }

  /** Stops the idle retry. The flag stays, so the next turn.complete asks again. */
  function haltOnce(/** @type {{ exitCode: number, stderr: string }} */ result) {
    onceHalted = true;
    if (result.exitCode === EXIT_INTERRUPTED || onceWarned || watchReported) return;
    onceWarned = true;
    const match = WATCH_ERROR_LINE.exec(result.stderr);
    const cause = match?.[1] ?? `exit code ${String(result.exitCode)}`;
    host.toast(
      `hivectl watch --once failed with ${cause}. The mod will ask again at the next turn or event.`,
    );
  }

  /** Reads one watch process to its end. Returns its exit info and stderr tail. */
  async function consume(/** @type {SpawnedProcess} */ proc) {
    let stdoutBuffer = '';
    let stderrTail = '';
    for (;;) {
      const step = await proc.next();
      if (step.done) return { exit: step.value, stderrTail };
      const piece = step.value;
      if (piece.stream === 'stderr') {
        stderrTail = (stderrTail + piece.text).slice(-STDERR_TAIL_CHARS);
        continue;
      }
      stdoutBuffer += piece.text;
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const l of lines) void onWatchLine(l);
    }
  }

  function describeFailure(/** @type {string} */ stderrTail, /** @type {number | null} */ code) {
    const match = WATCH_ERROR_LINE.exec(stderrTail);
    if (match)
      return `hivectl watch stopped with ${match[1]}${match[2] ? `: ${match[2]}` : ''}. It will not restart; fix the cause and reload the plugin.`;
    return `hivectl watch stopped with exit code ${String(code)} and will not restart; fix the cause and reload the plugin.`;
  }

  async function supervise() {
    let backoff = BACKOFF_MIN_MS;
    let shortRuns = 0;
    let warned = false;
    while (!stopped) {
      const startedAt = host.now();
      let outcome;
      try {
        child = host.spawn(watchArgv());
        outcome = await consume(child);
      } catch (err) {
        if (stopped) return;
        const reason = err instanceof Error ? err.message : String(err);
        host.toast(
          `Could not start hivectl watch (${reason}). Check that hivectl is installed and on PATH.`,
        );
        return;
      }
      child = undefined;
      if (stopped) return;
      const { exit, stderrTail } = outcome;
      if (exit.code === EXIT_INTERRUPTED) return;
      if (exit.code === EXIT_PRECONDITION || exit.code === EXIT_USER_ERROR) {
        watchReported = true;
        host.toast(describeFailure(stderrTail, exit.code));
        return;
      }
      const lived = host.now() - startedAt;
      if (lived >= HEALTHY_MS) {
        backoff = BACKOFF_MIN_MS;
        shortRuns = 0;
      } else {
        shortRuns += 1;
      }
      if (shortRuns >= CRASH_WARNING_AFTER && !warned) {
        warned = true;
        host.toast(
          'hivectl watch keeps crashing; it is being restarted with backoff. Check its stderr.',
        );
      }
      await host.sleep(backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    }
  }

  return {
    start() {
      if (started) return;
      started = true;
      void supervise();
    },
    onTurnStart() {
      turnActive = true;
      cancelRetry();
    },
    onTurnComplete() {
      turnActive = false;
      void runOnce();
    },
    async stop() {
      stopped = true;
      cancelRetry();
      const proc = child;
      child = undefined;
      if (proc) await proc.return().catch(() => {});
    },
  };
}
