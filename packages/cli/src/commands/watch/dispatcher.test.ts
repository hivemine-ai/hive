import { ListenError } from '@hive/client';
import type { UnreadSummary, WatchEvent } from '@hive/client';
import { describe, expect, it } from 'vitest';

import { createDispatcher } from './dispatcher.js';
import type { DispatcherDeps, DispatcherOptions } from './dispatcher.js';
import type { WatchError } from './errors.js';

const evt = (id: string, count = 1): WatchEvent => ({ eventId: id, senders: ['s'], count });
const tick = (n = 3): Promise<void> =>
  Array.from({ length: n }).reduce<Promise<void>>(
    (p) => p.then(() => new Promise<void>((r) => setImmediate(r))),
    Promise.resolve(),
  );

interface Deferred<T> {
  promise: Promise<T>;
  resolve(v: T): void;
  reject(e: unknown): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Rig {
  emitted: string[];
  execCalls: string[];
  requeries: number;
  delays: number[];
  fatal: WatchError[];
  inFlight: { max: number };
  clock: { now: number };
  dispatcher: ReturnType<typeof createDispatcher>;
  controller: AbortController;
}

interface RigConfig {
  exec?: ((event: WatchEvent) => Promise<number>) | null;
  requery?: () => Promise<UnreadSummary>;
  options?: Partial<DispatcherOptions>;
}

function rig(config: RigConfig = {}): Rig {
  const controller = new AbortController();
  const r: Rig = {
    emitted: [],
    execCalls: [],
    requeries: 0,
    delays: [],
    fatal: [],
    inFlight: { max: 0 },
    clock: { now: 0 },
    dispatcher: undefined as unknown as Rig['dispatcher'],
    controller,
  };
  let running = 0;
  const execFn = config.exec === null ? undefined : config.exec;
  const deps: DispatcherDeps = {
    emit: (e) => r.emitted.push(e.eventId.startsWith('check:') ? 'check' : e.eventId),
    exec: execFn
      ? async (e) => {
          running += 1;
          r.inFlight.max = Math.max(r.inFlight.max, running);
          r.execCalls.push(e.eventId.startsWith('check:') ? 'check' : e.eventId);
          try {
            return await execFn(e);
          } finally {
            running -= 1;
          }
        }
      : undefined,
    requery: () => {
      r.requeries += 1;
      return (config.requery ?? (() => Promise.resolve({ count: 0, senders: [] })))();
    },
    sleep: (ms) => {
      r.delays.push(ms);
      r.clock.now += ms;
      return Promise.resolve();
    },
    now: () => r.clock.now,
    random: () => 0.5,
    log: () => {},
    onFatal: (err) => r.fatal.push(err),
  };
  r.dispatcher = createDispatcher(
    {
      signal: controller.signal,
      execMaxRetries: 3,
      authRetryMaxMs: 300_000,
      backoff: { minMs: 10, maxMs: 80, factor: 2, jitter: 0 },
      ...config.options,
    },
    deps,
  );
  return r;
}

describe('dispatcher without --exec', () => {
  it('emits every event as it arrives and never queries', async () => {
    const r = rig({ exec: null });
    r.dispatcher.handle(evt('a'));
    r.dispatcher.handle(evt('b'));
    r.dispatcher.handle(evt('c'));
    await r.dispatcher.idle();
    expect(r.emitted).toEqual(['a', 'b', 'c']);
    expect(r.requeries).toBe(0);
  });
});

describe('dispatcher with --exec', () => {
  it('runs one command per event and emits the line', async () => {
    const r = rig({ exec: () => Promise.resolve(0) });
    r.dispatcher.handle(evt('a'));
    await r.dispatcher.idle();
    expect(r.emitted).toEqual(['a']);
    expect(r.execCalls).toEqual(['a']);
    expect(r.requeries).toBe(0);
  });

  it('collapses N events during a run into one flag and one query', async () => {
    const gate = deferred<number>();
    const r = rig({
      exec: (e) => (e.eventId === 'a' ? gate.promise : Promise.resolve(0)),
      requery: () => Promise.resolve({ count: 4, senders: ['s'] }),
    });
    r.dispatcher.handle(evt('a'));
    await tick();
    for (let i = 0; i < 7; i += 1) r.dispatcher.handle(evt(`n${i}`));
    expect(r.emitted).toEqual(['a']);
    gate.resolve(0);
    await r.dispatcher.idle();
    expect(r.requeries).toBe(1);
    expect(r.execCalls).toEqual(['a', 'check']);
    expect(r.emitted).toEqual(['a', 'check']);
    expect(r.inFlight.max).toBe(1);
  });

  it('does not run a second command when the query finds nothing unread', async () => {
    const gate = deferred<number>();
    const r = rig({ exec: () => gate.promise });
    r.dispatcher.handle(evt('a'));
    await tick();
    r.dispatcher.handle(evt('b'));
    gate.resolve(0);
    await r.dispatcher.idle();
    expect(r.requeries).toBe(1);
    expect(r.execCalls).toEqual(['a']);
  });

  it('does not query when no event arrived during the run', async () => {
    const r = rig({ exec: () => Promise.resolve(0) });
    r.dispatcher.handle(evt('a'));
    await r.dispatcher.idle();
    expect(r.requeries).toBe(0);
  });

  it('does not loop: unread messages without a new event cause no further run', async () => {
    const r = rig({
      exec: () => Promise.resolve(0),
      requery: () => Promise.resolve({ count: 2, senders: ['s'] }),
    });
    r.dispatcher.handle(evt('a'));
    await r.dispatcher.idle();
    expect(r.execCalls).toEqual(['a']);
    await tick(5);
    expect(r.execCalls).toEqual(['a']);
  });

  it('turns the flag off before querying so an event during the query re-arms it', async () => {
    const queryGate = deferred<UnreadSummary>();
    const first = deferred<number>();
    let started = false;
    let queries = 0;
    const r = rig({
      exec: () => {
        if (started) return Promise.resolve(0);
        started = true;
        return first.promise;
      },
      requery: () => {
        queries += 1;
        return queries === 1 ? queryGate.promise : Promise.resolve({ count: 0, senders: [] });
      },
    });
    r.dispatcher.handle(evt('a'));
    await tick();
    r.dispatcher.handle(evt('b'));
    first.resolve(0);
    await tick();
    expect(queries).toBe(1);
    r.dispatcher.handle(evt('c'));
    queryGate.resolve({ count: 0, senders: [] });
    await r.dispatcher.idle();
    expect(queries).toBe(2);
  });

  it('keeps the flag when the query fails and retries with backoff', async () => {
    const gate = deferred<number>();
    let attempts = 0;
    const r = rig({
      exec: (e) => (e.eventId === 'a' ? gate.promise : Promise.resolve(0)),
      requery: () => {
        attempts += 1;
        if (attempts < 3) return Promise.reject(new ListenError('transport', 'boom'));
        return Promise.resolve({ count: 1, senders: ['s'] });
      },
    });
    r.dispatcher.handle(evt('a'));
    await tick();
    r.dispatcher.handle(evt('b'));
    gate.resolve(0);
    await r.dispatcher.idle();
    expect(attempts).toBe(3);
    expect(r.delays).toEqual([10, 20]);
    expect(r.execCalls).toEqual(['a', 'check']);
  });

  it('ends with WATCH_CREDENTIAL_REJECTED when the query is rejected for the whole window', async () => {
    const gate = deferred<number>();
    const r = rig({
      exec: () => gate.promise,
      requery: () => Promise.reject(new ListenError('auth_rejected', 'rejected')),
      options: { authRetryMaxMs: 100 },
    });
    r.dispatcher.handle(evt('a'));
    await tick();
    r.dispatcher.handle(evt('b'));
    gate.resolve(0);
    await r.dispatcher.idle();
    expect(r.fatal.map((e) => e.code)).toEqual(['WATCH_CREDENTIAL_REJECTED']);
  });

  it('retries a failing command with backoff and emits the line once', async () => {
    let calls = 0;
    const r = rig({
      exec: () => {
        calls += 1;
        return Promise.resolve(calls < 3 ? 1 : 0);
      },
    });
    r.dispatcher.handle(evt('a'));
    await r.dispatcher.idle();
    expect(r.execCalls).toEqual(['a', 'a', 'a']);
    expect(r.emitted).toEqual(['a']);
    expect(r.delays).toEqual([10, 20]);
    expect(r.fatal).toEqual([]);
  });

  it('treats a command that cannot launch as a failed attempt', async () => {
    let calls = 0;
    const r = rig({
      exec: () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('ENOENT')) : Promise.resolve(0);
      },
    });
    r.dispatcher.handle(evt('a'));
    await r.dispatcher.idle();
    expect(calls).toBe(2);
    expect(r.fatal).toEqual([]);
  });

  it('ends with WATCH_EXEC_FAILED after the retries are exhausted', async () => {
    const r = rig({ exec: () => Promise.resolve(7) });
    r.dispatcher.handle(evt('a'));
    await r.dispatcher.idle();
    expect(r.execCalls).toHaveLength(4);
    expect(r.fatal.map((e) => e.code)).toEqual(['WATCH_EXEC_FAILED']);
  });

  it('makes a single attempt with zero retries', async () => {
    const r = rig({ exec: () => Promise.resolve(1), options: { execMaxRetries: 0 } });
    r.dispatcher.handle(evt('a'));
    await r.dispatcher.idle();
    expect(r.execCalls).toHaveLength(1);
    expect(r.fatal.map((e) => e.code)).toEqual(['WATCH_EXEC_FAILED']);
  });

  it('sets the flag for events that arrive during the retries', async () => {
    let calls = 0;
    const gate = deferred<number>();
    const r = rig({
      exec: (e) => {
        if (e.eventId === 'check') return Promise.resolve(0);
        calls += 1;
        return calls === 1 ? gate.promise : Promise.resolve(0);
      },
      requery: () => Promise.resolve({ count: 1, senders: ['s'] }),
    });
    r.dispatcher.handle(evt('a'));
    await tick();
    r.dispatcher.handle(evt('during'));
    gate.resolve(1);
    await r.dispatcher.idle();
    expect(r.requeries).toBe(1);
    expect(r.emitted).toEqual(['a', 'check']);
  });

  it('stops without starting new work once aborted', async () => {
    const gate = deferred<number>();
    const r = rig({ exec: () => gate.promise });
    r.dispatcher.handle(evt('a'));
    await tick();
    r.dispatcher.handle(evt('b'));
    r.controller.abort();
    gate.resolve(0);
    await r.dispatcher.idle();
    expect(r.requeries).toBe(0);
    expect(r.execCalls).toEqual(['a']);
  });
});
