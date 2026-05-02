import { describe, expect, it } from 'vitest';

import type { Sender, SendMessageInput, SendResult } from '#domain/cells/index.js';
import type { UUIDv7 } from '#domain/auth/types.js';

import type { ReferenceResolver } from '../reference-resolver.js';
import type { RequestContext } from '../types.js';

import { createSendMessageHandler, SendMessageInputSchema } from './send-message.js';

// ─────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────

const RECIPIENT_REF = 'admin@hive.local';
const RESOLVED_RECIPIENT_ID = '01900000-0000-7000-8000-000000000abc' as UUIDv7;
const FIXED_MESSAGE_ID = '01900000-0000-7000-8000-000000000001' as UUIDv7;
const FIXED_SENT_AT = new Date('2026-04-30T12:00:00.000Z');
const FIXED_DELIVERED_AT = new Date('2026-04-30T12:00:00.500Z');

interface StubSenderState {
  receivedCalls: SendMessageInput[];
}

function buildStubSender(): { sender: Sender; state: StubSenderState } {
  const state: StubSenderState = { receivedCalls: [] };

  const sender: Sender = {
    sendMessage(input: SendMessageInput): Promise<SendResult> {
      state.receivedCalls.push(input);
      return Promise.resolve({
        messageId: FIXED_MESSAGE_ID,
        sentAt: FIXED_SENT_AT,
        deliveredAt: FIXED_DELIVERED_AT,
        replayed: false,
      });
    },
  };

  return { sender, state };
}

function buildStubResolver(): ReferenceResolver {
  return {
    resolveParticipantReference(_input, _callerContext) {
      return Promise.resolve(RESOLVED_RECIPIENT_ID);
    },
    resolveCredentialActiveReference(_input, _callerContext) {
      return Promise.reject(new Error('not used by send_message'));
    },
  };
}

function buildContext(): RequestContext {
  // Minimal stub — the tool layer only forwards `ctx.identity` to the sender via
  // sendInput.callerContext, and the stub sender ignores its content. The empty
  // cast keeps the test focused on the schema and handler shaping behaviour.
  return {} as unknown as RequestContext;
}

// ─────────────────────────────────────────────────────────────────────────
// Tests — PRY-026 fix: action: null in input is equivalent to omitting the
// field, closing the round-trip asymmetry from INC-2026-001 finding #7. The
// schema previously rejected `null` with -32602, forcing clients that read
// stored messages (where action is always serialised as `null` when absent)
// to transform null → omitted before re-sending. Per ADR-017 (alternative A).
// ─────────────────────────────────────────────────────────────────────────

describe('send_message tool — action null asymmetry fix (PRY-026)', () => {
  describe('schema: SendMessageInputSchema (AC1, AC2)', () => {
    it('AC1: accepts { action: null } as a valid input — no -32602', () => {
      const result = SendMessageInputSchema.safeParse({
        recipient: RECIPIENT_REF,
        type: 'request',
        body: 'hello',
        action: null,
      });
      expect(result.success).toBe(true);
    });

    it('AC2 (regression): accepts omitted action — backward compat', () => {
      const result = SendMessageInputSchema.safeParse({
        recipient: RECIPIENT_REF,
        type: 'request',
        body: 'hello',
      });
      expect(result.success).toBe(true);
    });

    it('AC1: still accepts a populated action object — no behaviour change for non-null values', () => {
      const result = SendMessageInputSchema.safeParse({
        recipient: RECIPIENT_REF,
        type: 'request',
        body: 'hello',
        action: { kind: 'task.create', payload: { title: 't' } },
      });
      expect(result.success).toBe(true);
    });
  });

  describe('handler: null and omitted produce equivalent downstream calls (AC3, AC4)', () => {
    it('AC4: action: null does NOT propagate to sender input (handler treats null as "no action")', async () => {
      const { sender, state } = buildStubSender();
      const handler = createSendMessageHandler({ sender, resolver: buildStubResolver() });

      await handler(
        {
          recipient: RECIPIENT_REF,
          type: 'request',
          body: 'hello',
          action: null,
        },
        buildContext(),
      );

      expect(state.receivedCalls).toHaveLength(1);
      const captured = state.receivedCalls[0]!;
      // The crucial assertion: the `action` key is absent from sendInput when
      // input action was null. Domain `send.ts` then coerces `input.action ?? null`
      // → null, persisting consistently with the omitted case.
      expect('action' in captured).toBe(false);
    });

    it('AC3 (round-trip equivalence): null literal and omitted produce identical sender input shape', async () => {
      const { sender: senderOmitted, state: stateOmitted } = buildStubSender();
      const handlerOmitted = createSendMessageHandler({
        sender: senderOmitted,
        resolver: buildStubResolver(),
      });
      const { sender: senderNull, state: stateNull } = buildStubSender();
      const handlerNull = createSendMessageHandler({
        sender: senderNull,
        resolver: buildStubResolver(),
      });

      await handlerOmitted(
        { recipient: RECIPIENT_REF, type: 'notification', body: 'roundtrip' },
        buildContext(),
      );
      await handlerNull(
        { recipient: RECIPIENT_REF, type: 'notification', body: 'roundtrip', action: null },
        buildContext(),
      );

      expect(stateOmitted.receivedCalls).toHaveLength(1);
      expect(stateNull.receivedCalls).toHaveLength(1);

      const omittedKeys = Object.keys(stateOmitted.receivedCalls[0]!).sort();
      const nullKeys = Object.keys(stateNull.receivedCalls[0]!).sort();
      expect(nullKeys).toEqual(omittedKeys);

      // Both should have identical structurally relevant fields.
      expect(stateNull.receivedCalls[0]).toEqual(stateOmitted.receivedCalls[0]);
    });
  });
});
