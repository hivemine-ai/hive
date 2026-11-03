import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '#observability/logger.js';

import { createParticipantStateSignal } from './state-signal.js';

const CHANGE = {
  participantId: '01900000-0000-7000-8000-000000000001',
  newState: 'suspended',
} as const;

describe('createParticipantStateSignal', () => {
  it('delivers each change to every listener, synchronously', () => {
    const signal = createParticipantStateSignal();
    const first = vi.fn();
    const second = vi.fn();
    signal.onParticipantStateChanged(first);
    signal.onParticipantStateChanged(second);

    signal.emit(CHANGE);

    expect(first).toHaveBeenCalledWith(CHANGE);
    expect(second).toHaveBeenCalledWith(CHANGE);
  });

  it('a throwing listener is logged and does not reach the emitter or the others', () => {
    const warn = vi.fn();
    const signal = createParticipantStateSignal({ logger: { warn } as unknown as Logger });
    const after = vi.fn();
    signal.onParticipantStateChanged(() => {
      throw new Error('boom');
    });
    signal.onParticipantStateChanged(after);

    expect(() => {
      signal.emit(CHANGE);
    }).not.toThrow();
    expect(after).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'auth_state_listener_failed' }),
      expect.any(String),
    );
  });

  it('the returned function unsubscribes', () => {
    const signal = createParticipantStateSignal();
    const listener = vi.fn();
    const unsubscribe = signal.onParticipantStateChanged(listener);
    unsubscribe();
    signal.emit(CHANGE);
    expect(listener).not.toHaveBeenCalled();
  });
});
