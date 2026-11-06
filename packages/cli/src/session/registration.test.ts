import { describe, expect, it } from 'vitest';

import { SessionRegistration } from './registration.js';
import type { RegistrationDeps } from './registration.js';
import type { PersistedToken, TokenSlot } from './token-store.js';
import type { RegisterArgs, RegisterResponse } from './upstream.js';

const URL_ = 'http://hive.test/mcp';
const ENROLL = 'enroll-cred';
const NOW = Date.parse('2026-11-06T10:00:00Z');
const ARGS: RegisterArgs = { name: 'claude-api', description: 'Works on the API' };

interface Call {
  bearer: string;
  args: RegisterArgs;
}

function okResponse(token: string, name = 'claude-api'): RegisterResponse {
  return {
    ok: true,
    agentRef: `${name}@leo.hive`,
    agentId: `id-${name}`,
    token,
    expiresAt: new Date(NOW + 60 * 60 * 1000).toISOString(),
  };
}

function persisted(token: string, overrides: Partial<PersistedToken> = {}): PersistedToken {
  return {
    version: 1,
    serverUrl: URL_,
    agentRef: 'claude-api@leo.hive',
    agentId: 'id-claude-api',
    token,
    expiresAt: new Date(NOW - 60 * 1000).toISOString(),
    updatedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
    description: 'Saved description',
    ...overrides,
  };
}

/** In-memory token files and locks; `foreignLocks` are held by another process. */
function world(responses: RegisterResponse[], files: Record<string, PersistedToken> = {}) {
  const calls: Call[] = [];
  const held = new Set<string>();
  const foreignLocks = new Set<string>();
  const left: string[] = [];
  let enrollment: string | undefined = ENROLL;
  const deps: RegistrationDeps = {
    serverUrl: URL_,
    now: () => NOW,
    enrollmentCredential: () => enrollment,
    callRegister: (bearer, args) => {
      calls.push({ bearer, args });
      const next = responses.shift();
      if (next === undefined) throw new Error('unexpected register call');
      return Promise.resolve(next);
    },
    openSlot: (name): TokenSlot | undefined => {
      if (held.has(name) || foreignLocks.has(name)) return undefined;
      held.add(name);
      return {
        name,
        read: () => files[name],
        write: (t) => {
          files[name] = t;
        },
        remove: () => {
          delete files[name];
        },
        release: () => {
          held.delete(name);
        },
      };
    },
    leave: (current) => {
      left.push(current.name);
      return Promise.resolve();
    },
  };
  return {
    deps,
    calls,
    held,
    foreignLocks,
    files,
    left,
    setEnrollment: (v: string | undefined) => {
      enrollment = v;
    },
  };
}

describe('SessionRegistration.register', () => {
  it('(b) lock taken, no token file: registers with the enrollment credential and persists the token', async () => {
    const w = world([okResponse('t1')]);
    const reg = new SessionRegistration(w.deps);

    const outcome = await reg.register(ARGS);

    expect(outcome).toMatchObject({ ok: true, via: 'enrolled' });
    expect(w.calls).toEqual([{ bearer: ENROLL, args: ARGS }]);
    expect(reg.current).toMatchObject({
      name: 'claude-api',
      token: 't1',
      agentRef: 'claude-api@leo.hive',
    });
    expect(w.files['claude-api']).toMatchObject({
      token: 't1',
      serverUrl: URL_,
      description: 'Works on the API',
    });
    expect(w.held.has('claude-api')).toBe(true);
  });

  it('(a) lock taken and a valid token file: renews with that token as Bearer (no claim)', async () => {
    const w = world([okResponse('t2')], { 'claude-api': persisted('t1') });
    const reg = new SessionRegistration(w.deps);

    const outcome = await reg.register(ARGS);

    expect(outcome).toMatchObject({ ok: true, via: 'renewed' });
    expect(w.calls).toEqual([{ bearer: 't1', args: ARGS }]);
    expect(w.files['claude-api']?.token).toBe('t2');
  });

  it('(a) a -32001 on the renewal deletes the file and falls back to enrollment, keeping the lock', async () => {
    const w = world(
      [{ ok: false, code: 'auth_rejected', message: 'x', rpcCode: -32001 }, okResponse('t3')],
      { 'claude-api': persisted('t1') },
    );
    const reg = new SessionRegistration(w.deps);

    const outcome = await reg.register(ARGS);

    expect(outcome).toMatchObject({ ok: true, via: 'enrolled' });
    expect(w.calls.map((c) => c.bearer)).toEqual(['t1', ENROLL]);
    expect(w.files['claude-api']?.token).toBe('t3');
    expect(w.held.has('claude-api')).toBe(true);
  });

  it('skips a token file of another server or past the holder-proof window, and removes it', async () => {
    const stale = persisted('old', {
      expiresAt: new Date(NOW - 8 * 24 * 3600 * 1000).toISOString(),
    });
    const w = world([okResponse('t1')], { 'claude-api': stale });
    const reg = new SessionRegistration(w.deps);

    await reg.register(ARGS);

    expect(w.calls.map((c) => c.bearer)).toEqual([ENROLL]);
    expect(w.files['claude-api']?.token).toBe('t1');
  });

  it('(c) lock held by another live session: never reads the file, registers with enrollment and reports name_in_use', async () => {
    const w = world([{ ok: false, code: 'name_in_use', message: 'in use', rpcCode: -32007 }], {
      'claude-api': persisted('their-token'),
    });
    w.foreignLocks.add('claude-api');
    const reg = new SessionRegistration(w.deps);

    const outcome = await reg.register(ARGS);

    expect(outcome).toEqual({ ok: false, code: 'name_in_use', message: 'in use', rpcCode: -32007 });
    expect(w.calls).toEqual([{ bearer: ENROLL, args: ARGS }]);
    expect(reg.current).toBeUndefined();
  });

  it('releases the lock when the registration of a new name fails', async () => {
    const w = world([{ ok: false, code: 'name_taken', message: 'manual', rpcCode: -32008 }]);
    const reg = new SessionRegistration(w.deps);

    await reg.register(ARGS);

    expect(w.held.size).toBe(0);
  });

  it('without an enrollment file fails with not_installed and sends nothing', async () => {
    const w = world([]);
    w.setEnrollment(undefined);
    const reg = new SessionRegistration(w.deps);

    expect(await reg.register(ARGS)).toMatchObject({ ok: false, code: 'not_installed' });
    expect(w.calls).toEqual([]);
  });

  it('reports a rejected enrollment credential as enrollment_rejected', async () => {
    const w = world([{ ok: false, code: 'auth_rejected', message: 'x', rpcCode: -32001 }]);
    const reg = new SessionRegistration(w.deps);

    expect(await reg.register(ARGS)).toMatchObject({ ok: false, code: 'enrollment_rejected' });
  });

  it('the same name again renews with the current token (update of the description)', async () => {
    const w = world([okResponse('t1'), okResponse('t2')]);
    const reg = new SessionRegistration(w.deps);
    await reg.register(ARGS);

    const outcome = await reg.register({ ...ARGS, description: 'New focus' });

    expect(outcome).toMatchObject({ ok: true, via: 'renewed' });
    expect(w.calls[1]).toEqual({ bearer: 't1', args: { ...ARGS, description: 'New focus' } });
    expect(reg.current?.description).toBe('New focus');
    expect(w.left).toEqual([]);
  });

  it('another name leaves the current identity first and swaps the lock', async () => {
    const w = world([okResponse('t1'), okResponse('u1', 'docs-bot')]);
    const reg = new SessionRegistration(w.deps);
    await reg.register(ARGS);

    const outcome = await reg.register({ name: 'docs-bot', description: 'Docs' });

    expect(outcome).toMatchObject({ ok: true, identityChanged: true });
    expect(w.left).toEqual(['claude-api']);
    expect([...w.held]).toEqual(['docs-bot']);
    expect(reg.current?.name).toBe('docs-bot');
  });

  it('without a description uses the one saved with the token, or fails with description_unknown', async () => {
    const w = world([okResponse('t2')], { 'claude-api': persisted('t1') });
    const reg = new SessionRegistration(w.deps);

    await reg.register({ name: 'claude-api' });
    expect(w.calls[0]?.args.description).toBe('Saved description');

    const bare = world([]);
    const other = new SessionRegistration(bare.deps);
    expect(await other.register({ name: 'claude-api' })).toMatchObject({
      ok: false,
      code: 'description_unknown',
    });
    expect(bare.held.size).toBe(0);
  });

  it('serializes concurrent operations: exactly one enrollment for two simultaneous calls', async () => {
    const w = world([okResponse('t1'), okResponse('t2')]);
    const reg = new SessionRegistration(w.deps);

    const [a, b] = await Promise.all([reg.register(ARGS), reg.register(ARGS)]);

    expect(a).toMatchObject({ ok: true, via: 'enrolled' });
    expect(b).toMatchObject({ ok: true, via: 'renewed' });
    expect(w.calls.map((c) => c.bearer)).toEqual([ENROLL, 't1']);
  });
});

describe('SessionRegistration.renew / reenroll / drop', () => {
  it('renews with the last token and rewrites the file', async () => {
    const w = world([okResponse('t1'), okResponse('t2')]);
    const reg = new SessionRegistration(w.deps);
    await reg.register(ARGS);

    expect(await reg.renew()).toMatchObject({ ok: true, via: 'renewed' });
    expect(w.calls[1]?.bearer).toBe('t1');
    expect(w.files['claude-api']?.token).toBe('t2');
  });

  it('returns auth_rejected from a rejected renewal without falling back on its own', async () => {
    const w = world([
      okResponse('t1'),
      { ok: false, code: 'auth_rejected', message: 'x', rpcCode: -32001 },
    ]);
    const reg = new SessionRegistration(w.deps);
    await reg.register(ARGS);

    expect(await reg.renew()).toMatchObject({ ok: false, code: 'auth_rejected' });
    expect(reg.current?.token).toBe('t1');
  });

  it('reenroll leaves the identity, deletes the file and registers again under the same lock', async () => {
    const w = world([okResponse('t1'), okResponse('t9')]);
    const reg = new SessionRegistration(w.deps);
    await reg.register(ARGS);

    const outcome = await reg.reenroll();

    expect(outcome).toMatchObject({ ok: true, via: 'enrolled' });
    expect(w.left).toEqual(['claude-api']);
    expect(w.calls[1]?.bearer).toBe(ENROLL);
    expect(w.files['claude-api']?.token).toBe('t9');
    expect(w.held.has('claude-api')).toBe(true);
  });

  it('a failed reenroll leaves the session unregistered and releases the lock', async () => {
    const w = world([
      okResponse('t1'),
      { ok: false, code: 'name_in_use', message: 'x', rpcCode: -32007 },
    ]);
    const reg = new SessionRegistration(w.deps);
    await reg.register(ARGS);

    expect(await reg.reenroll()).toMatchObject({ ok: false, code: 'name_in_use' });
    expect(reg.current).toBeUndefined();
    expect(w.held.size).toBe(0);
  });

  it('a transport failure on reenroll keeps the arguments, so the next attempt can retry', async () => {
    const w = world([
      okResponse('t1'),
      { ok: false, code: 'transport', message: 'down' },
      okResponse('t2'),
    ]);
    const reg = new SessionRegistration(w.deps);
    await reg.register(ARGS);

    expect(await reg.reenroll()).toMatchObject({ ok: false, code: 'transport' });
    expect(await reg.reenroll()).toMatchObject({ ok: true });
    expect(w.calls.map((c) => c.args.name)).toEqual(['claude-api', 'claude-api', 'claude-api']);
  });

  it('a model registration after a retryable reenroll failure reuses the lock it already holds (no leaked slot)', async () => {
    const w = world([
      okResponse('t1'),
      { ok: false, code: 'transport', message: 'down' },
      okResponse('t2'),
    ]);
    const reg = new SessionRegistration(w.deps);
    await reg.register(ARGS);
    await reg.reenroll();
    expect(w.held.has('claude-api')).toBe(true);

    const outcome = await reg.register(ARGS);

    expect(outcome).toMatchObject({ ok: true, via: 'enrolled' });
    expect(w.calls.map((c) => c.bearer)).toEqual(['enroll-cred', 'enroll-cred', 'enroll-cred']);
    expect([...w.held]).toEqual(['claude-api']);
    expect(w.files['claude-api']?.token).toBe('t2');
    reg.drop();
    expect(w.held.size).toBe(0);
  });

  it('drop releases the lock and keeps the file for the next process', async () => {
    const w = world([okResponse('t1')]);
    const reg = new SessionRegistration(w.deps);
    await reg.register(ARGS);

    reg.drop();

    expect(reg.current).toBeUndefined();
    expect(w.held.size).toBe(0);
    expect(w.files['claude-api']?.token).toBe('t1');
  });
});
