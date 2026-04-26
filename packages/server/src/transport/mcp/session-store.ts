import type { IdentityContext, UUIDv7 } from '#domain/auth/index.js';
import type { Subscription } from '#domain/notifications/index.js';

import { SessionError } from './error-mapper.js';
import type { SessionState } from './types.js';

export interface SessionStore {
  create(input: {
    sessionId: string;
    identity: IdentityContext;
    connectionId: UUIDv7;
  }): SessionState;
  requireIdentityFor(sessionId: string): IdentityContext;
  /**
   * Returns the full state for a sessionId or undefined. Does NOT throw on
   * missing or invalidated — callers needing the strict variant use
   * `requireIdentityFor` first then call this.
   */
  peek(sessionId: string): SessionState | undefined;
  attachSubscription(sessionId: string, subscription: Subscription): void;
  touch(sessionId: string, now?: () => Date): void;
  invalidate(sessionId: string): void;
  close(sessionId: string): void;
  closeAll(): void;
  size(): number;
}

export function createSessionStore(opts?: { now?: () => Date }): SessionStore {
  const defaultNow = opts?.now ?? (() => new Date());
  const sessions = new Map<string, SessionState>();

  function closeSubscription(state: SessionState): void {
    const sub = state.subscription;
    if (sub === null) return;
    state.subscription = null;
    try {
      sub.close();
    } catch {
      // Swallow to keep the store consistent.
    }
  }

  return {
    create({ sessionId, identity, connectionId }) {
      const existing = sessions.get(sessionId);
      if (existing !== undefined) {
        closeSubscription(existing);
      }
      const now = defaultNow();
      const state: SessionState = {
        sessionId,
        identity,
        connectionId,
        subscription: null,
        notifierRef: null,
        establishedAt: now,
        lastSeenAt: now,
        invalidated: false,
      };
      sessions.set(sessionId, state);
      return state;
    },

    requireIdentityFor(sessionId) {
      const state = sessions.get(sessionId);
      if (state === undefined) {
        throw new SessionError('SESSION_NOT_FOUND');
      }
      if (state.invalidated) {
        throw new SessionError('SESSION_INVALIDATED');
      }
      return state.identity;
    },

    peek(sessionId) {
      return sessions.get(sessionId);
    },

    attachSubscription(sessionId, subscription) {
      const state = sessions.get(sessionId);
      if (state === undefined) {
        throw new SessionError('SESSION_NOT_FOUND');
      }
      const prev = state.subscription;
      state.subscription = subscription;
      if (prev !== null) {
        try {
          prev.close();
        } catch {
          // Swallow to keep the store consistent.
        }
      }
    },

    touch(sessionId, now) {
      const state = sessions.get(sessionId);
      if (state === undefined || state.invalidated) return;
      const clockFn = now ?? defaultNow;
      state.lastSeenAt = clockFn();
    },

    invalidate(sessionId) {
      const state = sessions.get(sessionId);
      if (state === undefined || state.invalidated) return;
      state.invalidated = true;
      closeSubscription(state);
    },

    close(sessionId) {
      const state = sessions.get(sessionId);
      if (state === undefined) return;
      closeSubscription(state);
      sessions.delete(sessionId);
    },

    closeAll() {
      const snapshot = Array.from(sessions.values());
      for (const state of snapshot) {
        try {
          closeSubscription(state);
        } catch {
          // Per-session try/catch: error in one does not prevent closing others.
        }
        sessions.delete(state.sessionId);
      }
    },

    size() {
      return sessions.size;
    },
  };
}
