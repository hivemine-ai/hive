import { type Mock, describe, expect, it, vi } from 'vitest';
import { v7 as uuidv7 } from 'uuid';

import type { IdentityContext } from '#domain/auth/index.js';
import type { Subscription } from '#domain/notifications/index.js';

import { SessionError } from './error-mapper.js';
import { createSessionStore } from './session-store.js';

// ---------------------------------------------------------------------------
// Minimal fixture builders
// ---------------------------------------------------------------------------

// Local mock type: `close` is a `Mock` so the lint rule sees it as already
// bound and does not flag `expect(sub.close).toHaveBeenCalled*`.
type MockSubscription = Omit<Subscription, 'close'> & { close: Mock };

function makeIdentity(overrides?: Partial<IdentityContext>): IdentityContext {
  return {
    participantId: uuidv7(),
    kind: 'worker',
    hiveId: uuidv7(),
    colonyId: uuidv7(),
    snapshot: {
      issuedAt: new Date('2026-01-01T00:00:00Z'),
      credentialJti: uuidv7(),
      credentialKid: 'kid-001',
    },
    current: { state: 'active' },
    ...overrides,
  };
}

function makeSubscription(id = uuidv7()): MockSubscription {
  return {
    id,
    participantId: uuidv7(),
    subscribedAt: new Date('2026-01-01T00:00:00Z'),
    close: vi.fn(),
  };
}

function expectSessionError(fn: () => unknown, code: SessionError['code']): void {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(SessionError);
  expect((err as SessionError).code).toBe(code);
}

const T0 = new Date('2026-01-01T10:00:00Z');
const T1 = new Date('2026-01-01T10:01:00Z');

// ---------------------------------------------------------------------------
// Group 1 — create
// ---------------------------------------------------------------------------

describe('SessionStore — create', () => {
  it('creates fresh state with subscription: null, invalidated: false, and deterministic timestamps', () => {
    const store = createSessionStore({ now: () => T0 });
    const state = store.create({
      sessionId: 'sid-1',
      identity: makeIdentity(),
      connectionId: uuidv7(),
    });

    expect(state.sessionId).toBe('sid-1');
    expect(state.subscription).toBeNull();
    expect(state.notifierRef).toBeNull();
    expect(state.invalidated).toBe(false);
    expect(state.establishedAt).toEqual(T0);
    expect(state.lastSeenAt).toEqual(T0);
  });

  it('second create with same sessionId overwrites and closes previous subscription', () => {
    const store = createSessionStore({ now: () => T0 });
    const first = store.create({
      sessionId: 'sid-dup',
      identity: makeIdentity(),
      connectionId: uuidv7(),
    });
    const sub = makeSubscription();
    store.attachSubscription('sid-dup', sub);

    const second = store.create({
      sessionId: 'sid-dup',
      identity: makeIdentity(),
      connectionId: uuidv7(),
    });

    expect(second.sessionId).toBe('sid-dup');
    expect(sub.close).toHaveBeenCalledTimes(1);
    expect(second).not.toBe(first);
  });
});

// ---------------------------------------------------------------------------
// Group 2 — requireIdentityFor
// ---------------------------------------------------------------------------

describe('SessionStore — requireIdentityFor', () => {
  it('returns the identity for an active session', () => {
    const store = createSessionStore();
    const identity = makeIdentity();
    store.create({ sessionId: 'sid-1', identity, connectionId: uuidv7() });

    const result = store.requireIdentityFor('sid-1');

    expect(result).toBe(identity);
  });

  it('throws SessionError SESSION_NOT_FOUND for unknown sessionId', () => {
    const store = createSessionStore();

    expectSessionError(() => store.requireIdentityFor('unknown'), 'SESSION_NOT_FOUND');
  });

  it('throws SessionError SESSION_INVALIDATED after invalidate()', () => {
    const store = createSessionStore();
    store.create({ sessionId: 'sid-2', identity: makeIdentity(), connectionId: uuidv7() });
    store.invalidate('sid-2');

    expectSessionError(() => store.requireIdentityFor('sid-2'), 'SESSION_INVALIDATED');
  });
});

// ---------------------------------------------------------------------------
// Group 3 — attachSubscription
// ---------------------------------------------------------------------------

describe('SessionStore — attachSubscription', () => {
  it('attaches a subscription and session remains accessible', () => {
    const store = createSessionStore();
    const identity = makeIdentity();
    store.create({ sessionId: 'sid-1', identity, connectionId: uuidv7() });
    const sub = makeSubscription();

    store.attachSubscription('sid-1', sub);

    expect(store.requireIdentityFor('sid-1')).toBe(identity);
  });

  it('throws SessionError SESSION_NOT_FOUND if session does not exist', () => {
    const store = createSessionStore();
    const sub = makeSubscription();

    expectSessionError(() => store.attachSubscription('ghost', sub), 'SESSION_NOT_FOUND');
  });

  it('second attachSubscription closes the previous subscription and replaces it', () => {
    const store = createSessionStore();
    store.create({ sessionId: 'sid-1', identity: makeIdentity(), connectionId: uuidv7() });

    const sub1 = makeSubscription();
    const sub2 = makeSubscription();
    store.attachSubscription('sid-1', sub1);
    store.attachSubscription('sid-1', sub2);

    expect(sub1.close).toHaveBeenCalledTimes(1);
    expect(sub2.close).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Group 4 — touch
// ---------------------------------------------------------------------------

describe('SessionStore — touch', () => {
  it('bumps lastSeenAt using the injected clock', () => {
    const store = createSessionStore({ now: () => T0 });
    const state = store.create({
      sessionId: 'sid-1',
      identity: makeIdentity(),
      connectionId: uuidv7(),
    });
    expect(state.lastSeenAt).toEqual(T0);

    // `state` is a direct reference to the SessionState held in the map —
    // mutation is visible through this reference.
    store.touch('sid-1', () => T1);

    expect(state.lastSeenAt).toEqual(T1);
  });

  it('is a no-op on unknown sessionId (does not throw)', () => {
    const store = createSessionStore();

    expect(() => store.touch('unknown')).not.toThrow();
  });

  it('is a no-op when session is invalidated: does not throw, does not update lastSeenAt', () => {
    const store = createSessionStore({ now: () => T0 });
    const state = store.create({
      sessionId: 'sid-inv',
      identity: makeIdentity(),
      connectionId: uuidv7(),
    });
    store.invalidate('sid-inv');
    const seenBefore = state.lastSeenAt;

    store.touch('sid-inv', () => T1);

    expect(state.lastSeenAt).toEqual(seenBefore);
  });
});

// ---------------------------------------------------------------------------
// Group 5 — invalidate
// ---------------------------------------------------------------------------

describe('SessionStore — invalidate', () => {
  it('sets invalidated = true on the session', () => {
    const store = createSessionStore();
    const state = store.create({
      sessionId: 'sid-1',
      identity: makeIdentity(),
      connectionId: uuidv7(),
    });

    store.invalidate('sid-1');

    expect(state.invalidated).toBe(true);
  });

  it('closes the attached subscription if present', () => {
    const store = createSessionStore();
    store.create({ sessionId: 'sid-1', identity: makeIdentity(), connectionId: uuidv7() });
    const sub = makeSubscription();
    store.attachSubscription('sid-1', sub);

    store.invalidate('sid-1');

    expect(sub.close).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: second invalidate does not re-close subscription', () => {
    const store = createSessionStore();
    store.create({ sessionId: 'sid-1', identity: makeIdentity(), connectionId: uuidv7() });
    const sub = makeSubscription();
    store.attachSubscription('sid-1', sub);

    store.invalidate('sid-1');
    store.invalidate('sid-1');

    expect(sub.close).toHaveBeenCalledTimes(1);
  });

  it('is a no-op on unknown sessionId', () => {
    const store = createSessionStore();

    expect(() => store.invalidate('ghost')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Group 6 — close
// ---------------------------------------------------------------------------

describe('SessionStore — close', () => {
  it('removes the entry from the store, decrementing size()', () => {
    const store = createSessionStore();
    store.create({ sessionId: 'sid-1', identity: makeIdentity(), connectionId: uuidv7() });
    expect(store.size()).toBe(1);

    store.close('sid-1');

    expect(store.size()).toBe(0);
  });

  it('closes the attached subscription when closing a session', () => {
    const store = createSessionStore();
    store.create({ sessionId: 'sid-1', identity: makeIdentity(), connectionId: uuidv7() });
    const sub = makeSubscription();
    store.attachSubscription('sid-1', sub);

    store.close('sid-1');

    expect(sub.close).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: second close does not throw and does not re-close subscription', () => {
    const store = createSessionStore();
    store.create({ sessionId: 'sid-1', identity: makeIdentity(), connectionId: uuidv7() });
    const sub = makeSubscription();
    store.attachSubscription('sid-1', sub);

    store.close('sid-1');
    expect(() => store.close('sid-1')).not.toThrow();

    expect(sub.close).toHaveBeenCalledTimes(1);
  });

  it('is a no-op on unknown sessionId', () => {
    const store = createSessionStore();

    expect(() => store.close('ghost')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Group 7 — closeAll
// ---------------------------------------------------------------------------

describe('SessionStore — closeAll', () => {
  it('closes every session and clears the map', () => {
    const store = createSessionStore();
    store.create({ sessionId: 'sid-a', identity: makeIdentity(), connectionId: uuidv7() });
    store.create({ sessionId: 'sid-b', identity: makeIdentity(), connectionId: uuidv7() });
    const subA = makeSubscription();
    const subB = makeSubscription();
    store.attachSubscription('sid-a', subA);
    store.attachSubscription('sid-b', subB);

    store.closeAll();

    expect(store.size()).toBe(0);
    expect(subA.close).toHaveBeenCalledTimes(1);
    expect(subB.close).toHaveBeenCalledTimes(1);
  });

  it('continues closing remaining sessions even if one subscription.close() throws', () => {
    const store = createSessionStore();
    store.create({ sessionId: 'sid-a', identity: makeIdentity(), connectionId: uuidv7() });
    store.create({ sessionId: 'sid-b', identity: makeIdentity(), connectionId: uuidv7() });

    const subA = makeSubscription();
    const subB = makeSubscription();
    vi.mocked(subA.close).mockImplementation(() => {
      throw new Error('subscription close failed');
    });
    store.attachSubscription('sid-a', subA);
    store.attachSubscription('sid-b', subB);

    expect(() => store.closeAll()).not.toThrow();
    expect(subB.close).toHaveBeenCalledTimes(1);
    expect(store.size()).toBe(0);
  });

  it('store remains usable after closeAll: create works again', () => {
    const store = createSessionStore();
    store.create({ sessionId: 'sid-a', identity: makeIdentity(), connectionId: uuidv7() });
    store.closeAll();

    store.create({ sessionId: 'sid-new', identity: makeIdentity(), connectionId: uuidv7() });

    expect(store.size()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Group 8 — size
// ---------------------------------------------------------------------------

describe('SessionStore — size', () => {
  it('returns 0 on a fresh store', () => {
    const store = createSessionStore();

    expect(store.size()).toBe(0);
  });

  it('increments on create and decrements on close', () => {
    const store = createSessionStore();
    store.create({ sessionId: 'sid-a', identity: makeIdentity(), connectionId: uuidv7() });
    store.create({ sessionId: 'sid-b', identity: makeIdentity(), connectionId: uuidv7() });
    expect(store.size()).toBe(2);

    store.close('sid-a');
    expect(store.size()).toBe(1);

    store.close('sid-b');
    expect(store.size()).toBe(0);
  });
});
