import { describe, expect, it, vi } from 'vitest';

import { createCellEvents } from './events.js';
import type { CellClosedEvent, MessageDeliveredEvent } from './events.js';

describe('createCellEvents', () => {
  describe('messageDelivered', () => {
    it('roundtrips a payload from emit to on listeners', () => {
      const events = createCellEvents();
      const listener = vi.fn();
      events.on('messageDelivered', listener);

      const payload: MessageDeliveredEvent = {
        messageId: '019dffff-0000-0000-0000-00000000aaaa',
        cellId: '019dffff-0000-0000-0000-00000000bbbb',
        recipientId: '019dffff-0000-0000-0000-00000000cccc',
        fromParticipantId: '019dffff-0000-0000-0000-00000000dddd',
        type: 'request',
        deliveredAt: new Date('2026-04-26T10:00:00.000Z'),
      };
      events.emit('messageDelivered', payload);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(payload);
    });

    it('fans out to all subscribed listeners', () => {
      const events = createCellEvents();
      const a = vi.fn();
      const b = vi.fn();
      events.on('messageDelivered', a);
      events.on('messageDelivered', b);

      events.emit('messageDelivered', {
        messageId: '019dffff-0000-0000-0000-00000000aaaa',
        cellId: '019dffff-0000-0000-0000-00000000bbbb',
        recipientId: '019dffff-0000-0000-0000-00000000cccc',
        fromParticipantId: '019dffff-0000-0000-0000-00000000dddd',
        type: 'notification',
        deliveredAt: new Date(),
      });

      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
    });
  });

  describe('cellClosed', () => {
    it('roundtrips a payload from emit to on listeners', () => {
      const events = createCellEvents();
      const listener = vi.fn();
      events.on('cellClosed', listener);

      const payload: CellClosedEvent = {
        cellId: '019dffff-0000-0000-0000-00000000eeee',
        ownerId: '019dffff-0000-0000-0000-00000000ffff',
        closedAt: new Date('2026-04-26T11:00:00.000Z'),
        reason: 'participant_revoked',
      };
      events.emit('cellClosed', payload);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(payload);
    });
  });

  describe('off', () => {
    it('removes a previously attached listener', () => {
      const events = createCellEvents();
      const listener = vi.fn();
      events.on('messageDelivered', listener);
      events.off('messageDelivered', listener);

      events.emit('messageDelivered', {
        messageId: '019dffff-0000-0000-0000-00000000aaaa',
        cellId: '019dffff-0000-0000-0000-00000000bbbb',
        recipientId: '019dffff-0000-0000-0000-00000000cccc',
        fromParticipantId: '019dffff-0000-0000-0000-00000000dddd',
        type: 'response',
        deliveredAt: new Date(),
      });

      expect(listener).not.toHaveBeenCalled();
    });

    it('only removes the specified listener (others remain)', () => {
      const events = createCellEvents();
      const a = vi.fn();
      const b = vi.fn();
      events.on('messageDelivered', a);
      events.on('messageDelivered', b);
      events.off('messageDelivered', a);

      events.emit('messageDelivered', {
        messageId: '019dffff-0000-0000-0000-00000000aaaa',
        cellId: '019dffff-0000-0000-0000-00000000bbbb',
        recipientId: '019dffff-0000-0000-0000-00000000cccc',
        fromParticipantId: '019dffff-0000-0000-0000-00000000dddd',
        type: 'response',
        deliveredAt: new Date(),
      });

      expect(a).not.toHaveBeenCalled();
      expect(b).toHaveBeenCalledTimes(1);
    });
  });

  describe('emit with no listeners', () => {
    it('does not throw', () => {
      const events = createCellEvents();
      expect(() =>
        events.emit('cellClosed', {
          cellId: '019dffff-0000-0000-0000-00000000eeee',
          ownerId: '019dffff-0000-0000-0000-00000000ffff',
          closedAt: new Date(),
          reason: 'hivekeeper_cascade',
        }),
      ).not.toThrow();
    });
  });

  // PRY-010 hardening — per-listener exception handling for both sync throws
  // and async (Promise) rejections, funneled to the per-emit onError sink.
  describe('per-listener exception handling (PRY-010)', () => {
    it('catches sync throw + async reject independently and forwards both to onError', async () => {
      const events = createCellEvents();
      const onError = vi.fn();
      const survivor = vi.fn();

      events.on('messageDelivered', () => {
        throw new Error('sync boom');
      });
      events.on('messageDelivered', () =>
        // returning a rejecting Promise must reach onError, not unhandledRejection.
        Promise.reject(new Error('async boom')),
      );
      events.on('messageDelivered', survivor);

      const payload: MessageDeliveredEvent = {
        messageId: '019dffff-0000-0000-0000-00000000aaaa',
        cellId: '019dffff-0000-0000-0000-00000000bbbb',
        recipientId: '019dffff-0000-0000-0000-00000000cccc',
        fromParticipantId: '019dffff-0000-0000-0000-00000000dddd',
        type: 'request',
        deliveredAt: new Date(),
      };
      events.emit('messageDelivered', payload, onError);

      // Survivor still ran (a failing listener does NOT short-circuit fan-out).
      expect(survivor).toHaveBeenCalledTimes(1);
      expect(survivor).toHaveBeenCalledWith(payload);

      // Sync throw arrives synchronously.
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
      expect((onError.mock.calls[0]?.[0] as Error).message).toBe('sync boom');

      // Async reject lands after the microtask queue drains.
      await Promise.resolve();
      await Promise.resolve();
      expect(onError).toHaveBeenCalledTimes(2);
      const messages = onError.mock.calls.map((c) => (c[0] as Error).message).sort();
      expect(messages).toEqual(['async boom', 'sync boom']);
    });

    it('does not throw to the caller when a listener fails and no onError is provided', async () => {
      const events = createCellEvents();
      events.on('messageDelivered', () => {
        throw new Error('silently swallowed');
      });
      events.on('messageDelivered', () => Promise.reject(new Error('also swallowed')));

      expect(() =>
        events.emit('messageDelivered', {
          messageId: '019dffff-0000-0000-0000-00000000aaaa',
          cellId: '019dffff-0000-0000-0000-00000000bbbb',
          recipientId: '019dffff-0000-0000-0000-00000000cccc',
          fromParticipantId: '019dffff-0000-0000-0000-00000000dddd',
          type: 'notification',
          deliveredAt: new Date(),
        }),
      ).not.toThrow();
      // Drain microtasks so the async reject has a chance to surface (it shouldn't).
      await Promise.resolve();
      await Promise.resolve();
    });
  });
});
