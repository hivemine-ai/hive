import { describe, expect, it } from 'vitest';

import { HIVECTL } from './hivectl-path.js';
import { register } from './register.js';

const flush = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r));
};

/**
 * A stand-in for the host. `sessionId` is what `$.session.id()` answers; the
 * spike (PRY-089) saw it lag behind during /resume, so tests set it to a stale
 * value where that matters.
 */
function load({ marker = undefined, sessionId = 'sid-1', asyncHost = false } = {}) {
  const handlers = {};
  register((event, handler) => (handlers[event] = handler));
  const spawns = [];
  const procs = [];
  const toasts = [];
  const host = { sessionId };
  const answer = (value) => (asyncHost ? Promise.resolve(value) : value);
  const $ = {
    session: { id: () => answer(host.sessionId) },
    env: { get: (name) => answer(name === 'HIVE_HARNESS_SESSION' ? marker : undefined) },
    process: {
      spawn: ({ argv }) => {
        spawns.push(argv);
        const proc = { killed: false };
        procs.push(proc);
        /** @type {((step: unknown) => void)[]} */
        const waiting = [];
        const ended = { done: true, value: { code: null, signal: 'SIGTERM' } };
        return {
          next: () => (proc.killed ? Promise.resolve(ended) : new Promise((r) => waiting.push(r))),
          return: () => {
            proc.killed = true;
            for (const r of waiting.splice(0)) r(ended);
            return Promise.resolve(ended);
          },
        };
      },
      run: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
    },
    prompt: { submit: () => Promise.resolve({}) },
    ui: { toast: (text) => toasts.push(text) },
  };
  const pass = (e) => Promise.resolve(e);
  return { handlers, $, spawns, procs, toasts, host, pass };
}

const attach = (sid) => [...HIVECTL, 'watch', '--attach-session', sid];

describe('register (waker mod)', () => {
  it('registers the session, classic SessionStart and turn hooks', () => {
    const { handlers } = load();
    expect(Object.keys(handlers).sort()).toEqual([
      'classic.SessionStart',
      'session.end',
      'session.start',
      'turn.complete',
      'turn.start',
    ]);
  });

  it('defaults to hivectl on the PATH until claude install fixes the absolute command', () => {
    expect(HIVECTL).toEqual(['hivectl']);
  });

  it.each([false, true])(
    'starts hivectl watch --attach-session <session id> at session.start (async host: %s)',
    async (asyncHost) => {
      const t = load({ asyncHost });
      await t.handlers['session.start'](t.$, {}, t.pass);
      await flush();
      expect(t.spawns).toEqual([attach('sid-1')]);
    },
  );

  it('with the harness marker launches no watch at all', async () => {
    const t = load({ marker: '/state/harness/x.json' });
    await t.handlers['session.start'](t.$, {}, t.pass);
    await t.handlers['classic.SessionStart'](
      t.$,
      { session_id: 'sid-2', source: 'startup' },
      t.pass,
    );
    await flush();
    expect(t.spawns).toEqual([]);
  });

  it('the classic SessionStart of the same session changes nothing', async () => {
    const t = load();
    await t.handlers['session.start'](t.$, {}, t.pass);
    await t.handlers['classic.SessionStart'](
      t.$,
      { session_id: 'sid-1', source: 'startup' },
      t.pass,
    );
    await flush();
    expect(t.spawns).toEqual([attach('sid-1')]);
  });

  it('after /resume retargets to e.session_id, never to the stale $.session.id()', async () => {
    const t = load();
    await t.handlers['session.start'](t.$, {}, t.pass);
    await flush();
    t.host.sessionId = 'sid-1';
    await t.handlers['session.end'](t.$, { reason: 'resume' }, t.pass);
    await t.handlers['classic.SessionStart'](
      t.$,
      { session_id: 'sid-2', source: 'resume' },
      t.pass,
    );
    await flush();
    expect(t.procs[0].killed).toBe(true);
    expect(t.spawns).toEqual([attach('sid-1'), attach('sid-2')]);
  });

  it('after /clear keeps the controller through session.end and retargets', async () => {
    const t = load();
    await t.handlers['session.start'](t.$, {}, t.pass);
    await flush();
    await t.handlers['session.end'](t.$, { reason: 'clear' }, t.pass);
    await t.handlers['classic.SessionStart'](t.$, { session_id: 'sid-3', source: 'clear' }, t.pass);
    await flush();
    expect(t.spawns).toEqual([attach('sid-1'), attach('sid-3')]);
  });

  it('a final session.end stops watch, and a later session.start starts a fresh one', async () => {
    const t = load();
    await t.handlers['session.start'](t.$, {}, t.pass);
    await flush();
    await t.handlers['session.end'](t.$, { reason: 'other' }, t.pass);
    expect(t.procs[0].killed).toBe(true);
    await t.handlers['session.start'](t.$, {}, t.pass);
    await flush();
    expect(t.spawns).toHaveLength(2);
  });

  it('a classic SessionStart without a prior session.start starts watch for its session id', async () => {
    const t = load();
    await t.handlers['classic.SessionStart'](
      t.$,
      { session_id: 'sid-7', source: 'startup' },
      t.pass,
    );
    await flush();
    expect(t.spawns).toEqual([attach('sid-7')]);
  });

  it('passes events through to the next hook and ignores subagent turns', async () => {
    const t = load();
    await t.handlers['session.start'](t.$, {}, t.pass);
    const e = { agentId: 'sub-1', turnId: 't' };
    expect(await t.handlers['turn.start'](t.$, e, t.pass)).toBe(e);
    expect(await t.handlers['turn.complete'](t.$, e, t.pass)).toBe(e);
    const s = { session_id: 'sid-1', source: 'startup' };
    expect(await t.handlers['classic.SessionStart'](t.$, s, t.pass)).toBe(s);
    await flush();
  });
});
