import { describe, expect, it } from 'vitest';

import { createController } from './controller.js';

const flush = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r));
};
const line = (id, count = 1) => `${JSON.stringify({ eventId: id, senders: ['s1'], count })}\n`;

/** A controllable stand-in for one `$.process.spawn` child. */
function fakeProc() {
  const chunks = [];
  const waiters = [];
  let result;
  let finished = false;
  const proc = {
    killed: false,
    push(stream, text) {
      const chunk = { stream, text };
      const w = waiters.shift();
      if (w) w({ done: false, value: chunk });
      else chunks.push(chunk);
    },
    exit(code, signal = null) {
      finished = true;
      result = { code, signal };
      for (const w of waiters.splice(0)) w({ done: true, value: result });
    },
    iterator: {
      next() {
        const chunk = chunks.shift();
        if (chunk) return Promise.resolve({ done: false, value: chunk });
        if (finished) return Promise.resolve({ done: true, value: result });
        return new Promise((resolve) => waiters.push(resolve));
      },
      return() {
        proc.killed = true;
        finished = true;
        result ??= { code: null, signal: 'SIGTERM' };
        for (const w of waiters.splice(0)) w({ done: true, value: result });
        return Promise.resolve({ done: true, value: result });
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    },
  };
  return proc;
}

function setup(overrides = {}) {
  const calls = { submit: [], run: [], toast: [], sleeps: [], spawn: [] };
  const procs = [];
  const clock = { now: 0 };
  const hold = { on: false, pending: [] };
  let submitImpl = () => Promise.resolve({ text: 'ok' });
  let runImpl = () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  let spawnImpl = null;
  const host = {
    spawn: (argv) => {
      calls.spawn.push(argv);
      if (spawnImpl) return spawnImpl(argv);
      const p = fakeProc();
      procs.push(p);
      return p.iterator;
    },
    run: (argv) => {
      calls.run.push(argv);
      return runImpl(argv);
    },
    submit: (text) => {
      calls.submit.push(text);
      return submitImpl(text);
    },
    toast: (text) => calls.toast.push(text),
    sleep: (ms) => {
      calls.sleeps.push(ms);
      clock.now += ms;
      if (!hold.on) return Promise.resolve();
      return new Promise((resolve) => hold.pending.push(resolve));
    },
    now: () => clock.now,
    ...overrides,
  };
  const controller = createController({
    options: { hivectl: ['hivectl'], sessionId: 'sid-1' },
    host,
  });
  return {
    controller,
    calls,
    procs,
    clock,
    hold,
    /** Releases the sleeps that are waiting, one round. */
    releaseSleeps: async () => {
      for (const r of hold.pending.splice(0)) r();
      await flush();
    },
    setSubmit: (f) => (submitImpl = f),
    setRun: (f) => (runImpl = f),
    setSpawn: (f) => (spawnImpl = f),
  };
}

describe('launching watch', () => {
  it('spawns hivectl watch --attach-session with the session id, and no credential', async () => {
    const t = setup();
    t.controller.start();
    await flush();
    expect(t.calls.spawn[0]).toEqual(['hivectl', 'watch', '--attach-session', 'sid-1']);
  });

  it('runs hivectl through the command prefix fixed by claude install (node plus script)', async () => {
    const calls = [];
    const controller = createController({
      options: { hivectl: ['/opt/node', '/opt/hivectl/main.js'], sessionId: 'sid-9' },
      host: {
        spawn: (argv) => {
          calls.push(argv);
          return fakeProc().iterator;
        },
        run: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
        submit: () => Promise.resolve({}),
        toast: () => {},
        sleep: () => Promise.resolve(),
        now: () => 0,
      },
    });
    controller.start();
    await flush();
    expect(calls[0]).toEqual([
      '/opt/node',
      '/opt/hivectl/main.js',
      'watch',
      '--attach-session',
      'sid-9',
    ]);
  });

  it('does not start a second watch', async () => {
    const t = setup();
    t.controller.start();
    t.controller.start();
    await flush();
    expect(t.calls.spawn).toHaveLength(1);
  });
});

describe('waking an idle session', () => {
  it('starts a turn with the fixed template when no turn is active', async () => {
    const t = setup();
    t.controller.start();
    await flush();
    t.procs[0].push('stdout', line('e1', 2));
    await flush();
    expect(t.calls.submit).toHaveLength(1);
    expect(t.calls.submit[0]).toContain('2 unread');
    expect(t.calls.run).toHaveLength(0);
  });

  it('ignores a line that is not a valid event', async () => {
    const t = setup();
    t.controller.start();
    await flush();
    t.procs[0].push('stdout', 'garbage\n{"eventId":"x"}\n');
    await flush();
    expect(t.calls.submit).toHaveLength(0);
  });

  it('reassembles a line that arrives in pieces', async () => {
    const t = setup();
    t.controller.start();
    await flush();
    const full = line('e1');
    t.procs[0].push('stdout', full.slice(0, 10));
    t.procs[0].push('stdout', full.slice(10));
    await flush();
    expect(t.calls.submit).toHaveLength(1);
  });

  it('never passes asUser to the host', async () => {
    const submitted = [];
    const t = setup({ submit: (text) => (submitted.push(text), Promise.resolve({})) });
    t.controller.start();
    await flush();
    t.procs[0].push('stdout', line('e1'));
    await flush();
    expect(submitted.every((x) => typeof x === 'string')).toBe(true);
  });
});

describe('the pending flag', () => {
  async function started() {
    const t = setup();
    t.hold.on = true;
    t.controller.start();
    await flush();
    t.controller.onTurnStart();
    return t;
  }

  it('N lines during a turn set one flag and start no turn', async () => {
    const t = await started();
    for (let i = 0; i < 5; i += 1) t.procs[0].push('stdout', line(`e${i}`));
    await flush();
    expect(t.calls.submit).toHaveLength(0);
    t.controller.onTurnComplete();
    await flush();
    expect(t.calls.run).toHaveLength(1);
  });

  it('launches --once at turn.complete when the flag is set', async () => {
    const t = await started();
    t.setRun(() => Promise.resolve({ exitCode: 0, stdout: line('check:1', 3), stderr: '' }));
    t.procs[0].push('stdout', line('e1'));
    await flush();
    t.controller.onTurnComplete();
    await flush();
    expect(t.calls.run[0]).toEqual(['hivectl', 'watch', '--once', '--attach-session', 'sid-1']);
    expect(t.calls.submit).toHaveLength(1);
    expect(t.calls.submit[0]).toContain('3 unread');
  });

  it('launches nothing at turn.complete without a flag', async () => {
    const t = await started();
    t.controller.onTurnComplete();
    await flush();
    expect(t.calls.run).toHaveLength(0);
    expect(t.calls.submit).toHaveLength(0);
  });

  it('clears the flag and starts no turn when --once prints nothing', async () => {
    const t = await started();
    t.procs[0].push('stdout', line('e1'));
    await flush();
    t.controller.onTurnComplete();
    await flush();
    expect(t.calls.submit).toHaveLength(0);
    t.controller.onTurnComplete();
    await flush();
    expect(t.calls.run).toHaveLength(1);
  });

  it('keeps the flag when --once fails and retries at the next turn.complete', async () => {
    const t = await started();
    t.setRun(() => Promise.resolve({ exitCode: 2, stdout: '', stderr: 'boom' }));
    t.procs[0].push('stdout', line('e1'));
    await flush();
    t.controller.onTurnComplete();
    await flush();
    expect(t.calls.run).toHaveLength(1);
    t.setRun(() => Promise.resolve({ exitCode: 0, stdout: line('c', 1), stderr: '' }));
    t.controller.onTurnComplete();
    await flush();
    expect(t.calls.run).toHaveLength(2);
    expect(t.calls.submit).toHaveLength(1);
  });

  it('keeps the flag when --once cannot be launched', async () => {
    const t = await started();
    t.setRun(() => Promise.reject(new Error('ENOENT')));
    t.procs[0].push('stdout', line('e1'));
    await flush();
    t.controller.onTurnComplete();
    await flush();
    t.setRun(() => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }));
    t.controller.onTurnComplete();
    await flush();
    expect(t.calls.run).toHaveLength(2);
  });

  it('keeps the flag when the host rejects the prompt', async () => {
    const t = await started();
    t.setRun(() => Promise.resolve({ exitCode: 0, stdout: line('c', 2), stderr: '' }));
    t.setSubmit(() => Promise.reject(new Error('rejected after Esc')));
    t.procs[0].push('stdout', line('e1'));
    await flush();
    t.controller.onTurnComplete();
    await flush();
    expect(t.calls.submit).toHaveLength(1);
    t.setSubmit(() => Promise.resolve({ text: 'ok' }));
    t.controller.onTurnComplete();
    await flush();
    expect(t.calls.run).toHaveLength(2);
    expect(t.calls.submit).toHaveLength(2);
  });

  it('treats a dropped prompt as a rejection', async () => {
    const t = await started();
    t.setRun(() => Promise.resolve({ exitCode: 0, stdout: line('c', 2), stderr: '' }));
    t.setSubmit(() => Promise.resolve({ drop: 'busy' }));
    t.procs[0].push('stdout', line('e1'));
    await flush();
    t.controller.onTurnComplete();
    await flush();
    t.setSubmit(() => Promise.resolve({ text: 'ok' }));
    t.controller.onTurnComplete();
    await flush();
    expect(t.calls.run).toHaveLength(2);
  });

  it('sets the flag when the idle submit is rejected, and recovers at turn.complete', async () => {
    const t = setup();
    t.hold.on = true;
    t.controller.start();
    await flush();
    t.setSubmit(() => Promise.reject(new Error('rejected')));
    t.procs[0].push('stdout', line('e1'));
    await flush();
    expect(t.calls.submit).toHaveLength(1);
    t.setSubmit(() => Promise.resolve({ text: 'ok' }));
    t.setRun(() => Promise.resolve({ exitCode: 0, stdout: line('c', 1), stderr: '' }));
    t.controller.onTurnComplete();
    await flush();
    expect(t.calls.run).toHaveLength(1);
    expect(t.calls.submit).toHaveLength(2);
  });

  it('keeps the flag for an event that arrives while --once runs', async () => {
    const t = await started();
    let release;
    t.setRun(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ exitCode: 0, stdout: '', stderr: '' });
        }),
    );
    t.procs[0].push('stdout', line('e1'));
    await flush();
    t.controller.onTurnComplete();
    await flush();
    t.procs[0].push('stdout', line('e2'));
    await flush();
    release();
    await flush();
    expect(t.calls.submit).toHaveLength(0);
    t.setRun(() => Promise.resolve({ exitCode: 0, stdout: line('c', 1), stderr: '' }));
    t.controller.onTurnComplete();
    await flush();
    expect(t.calls.submit).toHaveLength(1);
  });

  it('does not start a turn while --once is running', async () => {
    const t = await started();
    let release;
    t.setRun(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ exitCode: 0, stdout: '', stderr: '' });
        }),
    );
    t.procs[0].push('stdout', line('e1'));
    await flush();
    t.controller.onTurnComplete();
    await flush();
    t.procs[0].push('stdout', line('e2'));
    await flush();
    expect(t.calls.submit).toHaveLength(0);
    release();
    await flush();
  });
});

describe('when watch ends', () => {
  it('relaunches after a crash with exponential backoff', async () => {
    const t = setup();
    t.controller.start();
    await flush();
    t.procs[0].exit(2);
    await flush();
    t.procs[1].exit(2);
    await flush();
    t.procs[2].exit(null, 'SIGKILL');
    await flush();
    expect(t.calls.spawn).toHaveLength(4);
    expect(t.calls.sleeps).toEqual([1000, 2000, 4000]);
  });

  it('caps the backoff at 60 seconds', async () => {
    const t = setup();
    t.controller.start();
    await flush();
    for (let i = 0; i < 9; i += 1) {
      t.procs[i].exit(2);
      await flush();
    }
    expect(Math.max(...t.calls.sleeps)).toBe(60_000);
  });

  it('returns to the minimum backoff after 60 seconds of life', async () => {
    const t = setup();
    t.controller.start();
    await flush();
    t.procs[0].exit(2);
    await flush();
    t.procs[1].exit(2);
    await flush();
    t.clock.now += 61_000;
    t.procs[2].exit(2);
    await flush();
    expect(t.calls.sleeps.slice(0, 2)).toEqual([1000, 2000]);
    expect(t.calls.sleeps[2]).toBe(1000);
  });

  it.each([
    ['EXIT_PRECONDITION', 4],
    ['EXIT_USER_ERROR', 1],
  ])('does not relaunch on %s and tells the user the WATCH code', async (_name, code) => {
    const t = setup();
    t.controller.start();
    await flush();
    t.procs[0].push(
      'stderr',
      '{"event":"watch.connected"}\nerror: WATCH_CREDENTIAL_REJECTED: the server kept rejecting\n',
    );
    t.procs[0].exit(code);
    await flush();
    expect(t.calls.spawn).toHaveLength(1);
    expect(t.calls.toast).toHaveLength(1);
    expect(t.calls.toast[0]).toContain('WATCH_CREDENTIAL_REJECTED');
  });

  it('does not relaunch on EXIT_INTERRUPTED and stays quiet', async () => {
    const t = setup();
    t.controller.start();
    await flush();
    t.procs[0].exit(130);
    await flush();
    expect(t.calls.spawn).toHaveLength(1);
    expect(t.calls.toast).toHaveLength(0);
  });

  it('does not relaunch when hivectl cannot be started, and says so', async () => {
    const t = setup();
    t.setSpawn(() => ({
      next: () => Promise.reject(new Error('spawn hivectl ENOENT')),
      return: () => Promise.resolve({ done: true, value: undefined }),
      [Symbol.asyncIterator]() {
        return this;
      },
    }));
    t.controller.start();
    await flush();
    expect(t.calls.spawn).toHaveLength(1);
    expect(t.calls.toast[0]).toMatch(/hivectl/);
  });

  it('warns once when watch keeps crashing', async () => {
    const t = setup();
    t.controller.start();
    await flush();
    for (let i = 0; i < 8; i += 1) {
      t.procs[i].exit(2);
      await flush();
    }
    expect(t.calls.toast).toHaveLength(1);
    expect(t.calls.toast[0]).toMatch(/keeps/i);
  });

  it('stops the child and does not relaunch after stop()', async () => {
    const t = setup();
    t.controller.start();
    await flush();
    await t.controller.stop();
    await flush();
    expect(t.procs[0].killed).toBe(true);
    expect(t.calls.spawn).toHaveLength(1);
  });
});

describe('two lines in the same chunk', () => {
  it('opens one turn, not two, while the first submit is still pending', async () => {
    const t = setup();
    t.hold.on = true;
    let resolveSubmit;
    t.setSubmit(() => new Promise((resolve) => (resolveSubmit = resolve)));
    t.controller.start();
    await flush();
    t.procs[0].push('stdout', line('e1') + line('e2'));
    await flush();
    expect(t.calls.submit).toHaveLength(1);
    resolveSubmit({ text: 'ok' });
    await flush();
    expect(t.calls.submit).toHaveLength(1);
  });

  it('rolls the guard back when the submit fails, so the next attempt can start a turn', async () => {
    const t = setup();
    t.hold.on = true;
    t.setSubmit(() => Promise.reject(new Error('rejected')));
    t.controller.start();
    await flush();
    t.procs[0].push('stdout', line('e1') + line('e2'));
    await flush();
    expect(t.calls.submit).toHaveLength(1);
    t.setSubmit(() => Promise.resolve({ text: 'ok' }));
    t.setRun(() => Promise.resolve({ exitCode: 0, stdout: line('c', 1), stderr: '' }));
    await t.releaseSleeps();
    expect(t.calls.run).toHaveLength(1);
    expect(t.calls.submit).toHaveLength(2);
  });
});

describe('retrying while idle', () => {
  async function idleWithFlag() {
    const t = setup();
    t.hold.on = true;
    t.setSubmit(() => Promise.reject(new Error('rejected after Esc')));
    t.controller.start();
    await flush();
    t.procs[0].push('stdout', line('e1'));
    await flush();
    return t;
  }

  it('retries --once with a growing, bounded backoff while the flag is set and no turn runs', async () => {
    const t = await idleWithFlag();
    t.setRun(() => Promise.resolve({ exitCode: 2, stdout: '', stderr: '' }));
    const retrySleeps = () => t.calls.sleeps;
    await t.releaseSleeps();
    await t.releaseSleeps();
    await t.releaseSleeps();
    expect(t.calls.run.length).toBeGreaterThanOrEqual(3);
    const delays = retrySleeps();
    expect(delays.slice(0, 3)).toEqual([1000, 2000, 4000]);
    for (let i = 0; i < 12; i += 1) await t.releaseSleeps();
    expect(Math.max(...t.calls.sleeps)).toBe(60_000);
  });

  it('stops retrying once --once clears the flag', async () => {
    const t = await idleWithFlag();
    t.setRun(() => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }));
    await t.releaseSleeps();
    const runs = t.calls.run.length;
    await t.releaseSleeps();
    await t.releaseSleeps();
    expect(t.calls.run).toHaveLength(runs);
  });

  it('stops retrying when a turn starts', async () => {
    const t = await idleWithFlag();
    t.setRun(() => Promise.resolve({ exitCode: 2, stdout: '', stderr: '' }));
    t.controller.onTurnStart();
    await t.releaseSleeps();
    await t.releaseSleeps();
    expect(t.calls.run).toHaveLength(0);
    t.controller.onTurnComplete();
    await flush();
    expect(t.calls.run).toHaveLength(1);
  });

  it('stops retrying after stop()', async () => {
    const t = await idleWithFlag();
    t.setRun(() => Promise.resolve({ exitCode: 2, stdout: '', stderr: '' }));
    await t.controller.stop();
    await t.releaseSleeps();
    await t.releaseSleeps();
    expect(t.calls.run).toHaveLength(0);
  });

  it('retries after a failed --once triggered by turn.complete when the session is then idle', async () => {
    const t = await idleWithFlag();
    t.setRun(() => Promise.resolve({ exitCode: 2, stdout: '', stderr: '' }));
    t.controller.onTurnStart();
    t.controller.onTurnComplete();
    await flush();
    const afterComplete = t.calls.run.length;
    await t.releaseSleeps();
    await t.releaseSleeps();
    expect(t.calls.run.length).toBeGreaterThan(afterComplete);
  });
});

describe('terminal exits of --once', () => {
  async function idleWithFlag() {
    const t = setup();
    t.hold.on = true;
    t.setSubmit(() => Promise.resolve({ drop: 'busy' }));
    t.controller.start();
    await flush();
    t.procs[0].push('stdout', line('e1'));
    await flush();
    return t;
  }

  /** Lets the backoff run long enough to expose an unbounded retry. */
  const drain = async (t, rounds = 8) => {
    for (let i = 0; i < rounds; i += 1) await t.releaseSleeps();
  };

  it.each([
    ['EXIT_USER_ERROR', 1],
    ['EXIT_PRECONDITION', 4],
    ['EXIT_INTERRUPTED', 130],
  ])('stops the idle retry on %s', async (_name, exitCode) => {
    const t = await idleWithFlag();
    t.setRun(() => Promise.resolve({ exitCode, stdout: '', stderr: '' }));
    await drain(t);
    expect(t.calls.run).toHaveLength(1);
  });

  it('keeps retrying on an exit code that may be transient', async () => {
    const t = await idleWithFlag();
    t.setRun(() => Promise.resolve({ exitCode: 2, stdout: '', stderr: '' }));
    await drain(t);
    expect(t.calls.run.length).toBeGreaterThan(1);
  });

  it('warns once with the WATCH_ code on a rejected credential', async () => {
    const t = await idleWithFlag();
    t.setRun(() =>
      Promise.resolve({
        exitCode: 4,
        stdout: '',
        stderr: 'error: WATCH_CREDENTIAL_REJECTED: rejected\n',
      }),
    );
    await drain(t);
    t.controller.onTurnStart();
    t.controller.onTurnComplete();
    await flush();
    expect(t.calls.toast).toHaveLength(1);
    expect(t.calls.toast[0]).toContain('WATCH_CREDENTIAL_REJECTED');
    expect(t.calls.toast[0]).toContain('--once');
  });

  it('does not warn on EXIT_INTERRUPTED', async () => {
    const t = await idleWithFlag();
    t.setRun(() => Promise.resolve({ exitCode: 130, stdout: '', stderr: '' }));
    await drain(t);
    expect(t.calls.toast).toHaveLength(0);
  });

  it('keeps the flag, so the next turn.complete asks again and can recover', async () => {
    const t = await idleWithFlag();
    t.setRun(() => Promise.resolve({ exitCode: 4, stdout: '', stderr: '' }));
    await drain(t);
    t.setSubmit(() => Promise.resolve({ text: 'ok' }));
    t.setRun(() => Promise.resolve({ exitCode: 0, stdout: line('c', 2), stderr: '' }));
    t.controller.onTurnStart();
    t.controller.onTurnComplete();
    await flush();
    expect(t.calls.run).toHaveLength(2);
    expect(t.calls.submit).toHaveLength(2);
  });

  it('resumes the idle retry when a later event proves the stream is alive', async () => {
    const t = await idleWithFlag();
    t.setRun(() => Promise.resolve({ exitCode: 4, stdout: '', stderr: '' }));
    await drain(t);
    expect(t.calls.run).toHaveLength(1);
    t.setRun(() => Promise.resolve({ exitCode: 2, stdout: '', stderr: '' }));
    t.procs[0].push('stdout', line('e2'));
    await flush();
    await drain(t);
    expect(t.calls.run.length).toBeGreaterThan(1);
  });

  it('resumes the idle retry when a later --once fails with a transient exit', async () => {
    const t = await idleWithFlag();
    t.setRun(() => Promise.resolve({ exitCode: 4, stdout: '', stderr: '' }));
    await drain(t);
    t.setRun(() => Promise.resolve({ exitCode: 2, stdout: '', stderr: '' }));
    t.controller.onTurnStart();
    t.controller.onTurnComplete();
    await flush();
    const afterComplete = t.calls.run.length;
    await drain(t);
    expect(t.calls.run.length).toBeGreaterThan(afterComplete);
  });

  it('says the mod will ask again, not that the plugin must be reloaded', async () => {
    const t = await idleWithFlag();
    t.setRun(() => Promise.resolve({ exitCode: 4, stdout: '', stderr: '' }));
    await drain(t);
    expect(t.calls.toast[0]).toContain('ask again');
    expect(t.calls.toast[0]).not.toContain('reload');
  });

  it('adds no second notice when watch already reported its own stop', async () => {
    const t = await idleWithFlag();
    t.procs[0].push('stderr', 'error: WATCH_CREDENTIAL_REJECTED: rejected\n');
    t.procs[0].exit(4);
    await flush();
    expect(t.calls.toast).toHaveLength(1);
    t.setRun(() =>
      Promise.resolve({
        exitCode: 4,
        stdout: '',
        stderr: 'error: WATCH_CREDENTIAL_REJECTED: rejected\n',
      }),
    );
    await drain(t);
    expect(t.calls.run.length).toBeGreaterThan(0);
    expect(t.calls.toast).toHaveLength(1);
  });

  it('warns again after a success, for a new failure episode', async () => {
    const t = await idleWithFlag();
    t.setRun(() => Promise.resolve({ exitCode: 4, stdout: '', stderr: '' }));
    await drain(t);
    t.setSubmit(() => Promise.resolve({ text: 'ok' }));
    t.setRun(() => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }));
    t.controller.onTurnStart();
    t.controller.onTurnComplete();
    await flush();
    t.controller.onTurnStart();
    t.procs[0].push('stdout', line('e3'));
    await flush();
    t.setRun(() => Promise.resolve({ exitCode: 4, stdout: '', stderr: '' }));
    t.controller.onTurnComplete();
    await flush();
    expect(t.calls.toast).toHaveLength(2);
  });
});

describe('stop()', () => {
  it('does not submit a turn when stop arrives while --once is in flight', async () => {
    const t = setup();
    t.hold.on = true;
    t.controller.start();
    await flush();
    t.controller.onTurnStart();
    t.procs[0].push('stdout', line('e1'));
    await flush();
    let release;
    t.setRun(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ exitCode: 0, stdout: line('c', 2), stderr: '' });
        }),
    );
    t.controller.onTurnComplete();
    await flush();
    await t.controller.stop();
    release();
    await flush();
    expect(t.calls.submit).toHaveLength(0);
  });

  it('does not submit for a line that arrives after stop', async () => {
    const t = setup();
    t.controller.start();
    await flush();
    await t.controller.stop();
    t.procs[0].push('stdout', line('e1'));
    await flush();
    expect(t.calls.submit).toHaveLength(0);
  });
});

describe('retarget (session id changed by /clear or /resume)', () => {
  it('stops the current watch and starts one for the new session id at once, without backoff', async () => {
    const t = setup();
    t.controller.start();
    await flush();
    t.controller.retarget('sid-2');
    await flush();
    expect(t.procs[0].killed).toBe(true);
    expect(t.calls.spawn[1]).toEqual(['hivectl', 'watch', '--attach-session', 'sid-2']);
    expect(t.calls.sleeps).toEqual([]);
  });

  it('does nothing for the same session id', async () => {
    const t = setup();
    t.controller.start();
    await flush();
    t.controller.retarget('sid-1');
    await flush();
    expect(t.procs[0].killed).toBe(false);
    expect(t.calls.spawn).toHaveLength(1);
  });

  it('points --once at the new session id', async () => {
    const t = setup();
    t.controller.start();
    await flush();
    t.controller.retarget('sid-2');
    await flush();
    t.procs[1].push('stdout', line('e1'));
    await flush();
    t.procs[1].push('stdout', line('e2'));
    await flush();
    t.controller.onTurnComplete();
    await flush();
    expect(t.calls.run.at(-1)).toEqual(['hivectl', 'watch', '--once', '--attach-session', 'sid-2']);
  });

  it('starts watch again for the new id after it had stopped for good', async () => {
    const t = setup();
    t.controller.start();
    await flush();
    t.procs[0].push('stderr', 'error: WATCH_ATTACH_TARGET_NOT_FOUND: no session\n');
    t.procs[0].exit(1);
    await flush();
    expect(t.calls.toast).toHaveLength(1);
    t.controller.retarget('sid-2');
    await flush();
    expect(t.calls.spawn[1]).toEqual(['hivectl', 'watch', '--attach-session', 'sid-2']);
  });

  it('before start only records the id', async () => {
    const t = setup();
    t.controller.retarget('sid-3');
    await flush();
    expect(t.calls.spawn).toEqual([]);
    t.controller.start();
    await flush();
    expect(t.calls.spawn[0]).toEqual(['hivectl', 'watch', '--attach-session', 'sid-3']);
  });

  it('cuts the restart backoff short: a retarget during the sleep after a crash spawns at once', async () => {
    const t = setup();
    t.hold.on = true;
    t.controller.start();
    await flush();
    t.procs[0].exit(2);
    await flush();
    expect(t.calls.sleeps).toEqual([1000]);
    t.controller.retarget('sid-2');
    await flush();
    expect(t.calls.spawn[1]).toEqual(['hivectl', 'watch', '--attach-session', 'sid-2']);
  });

  it('a retarget without a running child leaves no pending restart: the next crash still backs off', async () => {
    const t = setup();
    t.hold.on = true;
    t.controller.start();
    await flush();
    t.procs[0].exit(2);
    await flush();
    t.controller.retarget('sid-2');
    await flush();
    t.procs[1].exit(2);
    await flush();
    expect(t.calls.sleeps).toHaveLength(2);
    expect(t.calls.spawn).toHaveLength(2);
  });
});
