import { describe, expect, it } from 'vitest';

import { ListenError } from './errors.js';
import type { WatchEvent } from './event.js';
import { runListenLoop } from './listen-loop.js';
import type {
  CloseReason,
  ConnectHandlers,
  ListenConnection,
  ListenLoopDeps,
} from './listen-loop.js';

interface FakeConn extends ListenConnection {
  end(reason: CloseReason): void;
  handlers: ConnectHandlers;
}

function fakeConnection(handlers: ConnectHandlers): FakeConn {
  let resolve!: (r: CloseReason) => void;
  const closed = new Promise<CloseReason>((r) => {
    resolve = r;
  });
  return {
    handlers,
    closed,
    close: () => {
      resolve('local');
      return Promise.resolve();
    },
    end: (reason) => resolve(reason),
  };
}

interface Harness {
  deps: ListenLoopDeps;
  delays: number[];
  clock: { now: number };
  connects: number;
}

function harness(
  connect: (h: Harness, handlers: ConnectHandlers) => Promise<ListenConnection>,
): Harness {
  const h: Harness = {
    delays: [],
    clock: { now: 0 },
    connects: 0,
    deps: undefined as unknown as ListenLoopDeps,
  };
  h.deps = {
    connect: (handlers) => {
      h.connects += 1;
      return connect(h, handlers);
    },
    sleep: (ms) => {
      h.delays.push(ms);
      h.clock.now += ms;
      return Promise.resolve();
    },
    now: () => h.clock.now,
    random: () => 0.5,
    log: () => {},
  };
  return h;
}

const evt = (id: string): WatchEvent => ({ eventId: id, senders: ['s'], count: 1 });
const tick = () => new Promise<void>((r) => setImmediate(r));

describe('runListenLoop', () => {
  it('delivers events and returns when aborted', async () => {
    const ac = new AbortController();
    const got: string[] = [];
    let conn!: FakeConn;
    const h = harness((_h, handlers) => {
      conn = fakeConnection(handlers);
      return Promise.resolve(conn);
    });
    const run = runListenLoop(
      { signal: ac.signal, authRetryMaxMs: 1000, onEvent: (e) => got.push(e.eventId) },
      h.deps,
    );
    await tick();
    conn.handlers.onEvent(evt('a'));
    conn.handlers.onEvent(evt('b'));
    ac.abort();
    conn.end('local');
    await run;
    expect(got).toEqual(['a', 'b']);
  });

  it('drops a repeated eventId within a connection', async () => {
    const ac = new AbortController();
    const got: string[] = [];
    let conn!: FakeConn;
    const h = harness((_h, handlers) => {
      conn = fakeConnection(handlers);
      return Promise.resolve(conn);
    });
    const run = runListenLoop(
      { signal: ac.signal, authRetryMaxMs: 1000, onEvent: (e) => got.push(e.eventId) },
      h.deps,
    );
    await tick();
    conn.handlers.onEvent(evt('a'));
    conn.handlers.onEvent(evt('a'));
    conn.handlers.onEvent(evt('b'));
    conn.handlers.onEvent(evt('a'));
    ac.abort();
    conn.end('local');
    await run;
    expect(got).toEqual(['a', 'b', 'a']);
  });

  it('forgets the last eventId on reconnect, so the same event wakes again', async () => {
    const ac = new AbortController();
    const got: string[] = [];
    const conns: FakeConn[] = [];
    const h = harness((_h, handlers) => {
      const c = fakeConnection(handlers);
      conns.push(c);
      return Promise.resolve(c);
    });
    const run = runListenLoop(
      { signal: ac.signal, authRetryMaxMs: 1000, onEvent: (e) => got.push(e.eventId) },
      h.deps,
    );
    await tick();
    conns[0]?.handlers.onEvent(evt('a'));
    conns[0]?.end('remote');
    await tick();
    await tick();
    conns[1]?.handlers.onEvent(evt('a'));
    ac.abort();
    conns[1]?.end('local');
    await run;
    expect(got).toEqual(['a', 'a']);
  });

  it('reconnects with backoff after a transport failure and never gives up', async () => {
    const ac = new AbortController();
    let attempts = 0;
    const h = harness((hh, handlers) => {
      attempts += 1;
      if (attempts <= 6) return Promise.reject(new ListenError('transport', 'connection refused'));
      const c = fakeConnection(handlers);
      hh.clock.now += 0;
      ac.abort();
      queueMicrotask(() => c.end('local'));
      return Promise.resolve(c);
    });
    await runListenLoop({ signal: ac.signal, authRetryMaxMs: 1000, onEvent: () => {} }, h.deps);
    expect(attempts).toBe(7);
    expect(h.delays.length).toBe(6);
    for (let i = 1; i < h.delays.length; i += 1) {
      expect(h.delays[i] ?? 0).toBeGreaterThanOrEqual(h.delays[i - 1] ?? 0);
    }
  });

  it('reconnects after the connection closes by silence', async () => {
    const ac = new AbortController();
    const conns: FakeConn[] = [];
    const h = harness((_h, handlers) => {
      const c = fakeConnection(handlers);
      conns.push(c);
      return Promise.resolve(c);
    });
    const run = runListenLoop(
      { signal: ac.signal, authRetryMaxMs: 1000, onEvent: () => {} },
      h.deps,
    );
    await tick();
    conns[0]?.end('silence');
    await tick();
    await tick();
    expect(conns.length).toBe(2);
    ac.abort();
    conns[1]?.end('local');
    await run;
  });

  it('retries on auth rejection and terminates once the window is spent', async () => {
    const ac = new AbortController();
    const h = harness(() => Promise.reject(new ListenError('auth_rejected', 'rejected')));
    const result = runListenLoop(
      { signal: ac.signal, authRetryMaxMs: 10_000, onEvent: () => {} },
      h.deps,
    );
    await expect(result).rejects.toMatchObject({ kind: 'auth_rejected' });
    expect(h.connects).toBeGreaterThan(1);
    expect(h.clock.now).toBeLessThanOrEqual(10_000 + 1);
  });

  it('terminates immediately on auth rejection with a zero window', async () => {
    const ac = new AbortController();
    const h = harness(() => Promise.reject(new ListenError('auth_rejected', 'rejected')));
    await expect(
      runListenLoop({ signal: ac.signal, authRetryMaxMs: 0, onEvent: () => {} }, h.deps),
    ).rejects.toMatchObject({ kind: 'auth_rejected' });
    expect(h.connects).toBe(1);
  });

  it('resumes when a suspended agent is reinstated inside the window', async () => {
    const ac = new AbortController();
    let attempts = 0;
    const h = harness((_hh, handlers) => {
      attempts += 1;
      if (attempts < 4) return Promise.reject(new ListenError('auth_rejected', 'rejected'));
      const c = fakeConnection(handlers);
      ac.abort();
      queueMicrotask(() => c.end('local'));
      return Promise.resolve(c);
    });
    await runListenLoop({ signal: ac.signal, authRetryMaxMs: 300_000, onEvent: () => {} }, h.deps);
    expect(attempts).toBe(4);
  });

  it('restarts the auth window after a successful connection', async () => {
    const ac = new AbortController();
    let attempts = 0;
    const conns: FakeConn[] = [];
    const h = harness((hh, handlers) => {
      attempts += 1;
      if (attempts === 1 || attempts === 3) {
        hh.clock.now += 8_000;
        return Promise.reject(new ListenError('auth_rejected', 'rejected'));
      }
      if (attempts === 2) {
        const c = fakeConnection(handlers);
        conns.push(c);
        return Promise.resolve(c);
      }
      const c = fakeConnection(handlers);
      ac.abort();
      queueMicrotask(() => c.end('local'));
      return Promise.resolve(c);
    });
    const run = runListenLoop(
      { signal: ac.signal, authRetryMaxMs: 10_000, onEvent: () => {} },
      h.deps,
    );
    await tick();
    await tick();
    conns[0]?.end('remote');
    await run;
    expect(attempts).toBe(4);
  });

  it('stops at once on an unsupported protocol', async () => {
    const ac = new AbortController();
    const h = harness(() => Promise.reject(new ListenError('protocol_unsupported', 'bad era')));
    await expect(
      runListenLoop({ signal: ac.signal, authRetryMaxMs: 1000, onEvent: () => {} }, h.deps),
    ).rejects.toMatchObject({ kind: 'protocol_unsupported' });
    expect(h.connects).toBe(1);
  });

  it('closes the connection when aborted while it is open', async () => {
    const ac = new AbortController();
    let closedByLoop = false;
    const h = harness((_hh, handlers) => {
      const c = fakeConnection(handlers);
      const origClose = c.close.bind(c);
      c.close = () => {
        closedByLoop = true;
        return origClose();
      };
      return Promise.resolve(c);
    });
    const run = runListenLoop(
      { signal: ac.signal, authRetryMaxMs: 1000, onEvent: () => {} },
      h.deps,
    );
    await tick();
    ac.abort();
    await run;
    expect(closedByLoop).toBe(true);
  });
});
