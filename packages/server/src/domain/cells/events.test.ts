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
});
