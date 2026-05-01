import { describe, expect, it } from 'vitest';

import { CellError } from '#domain/cells/index.js';
import type {
  Cell,
  CellsRepo,
  Message,
  Sender,
  SendMessageInput,
  SendResult,
} from '#domain/cells/index.js';
import type { UUIDv7 } from '#domain/auth/types.js';

import type { RequestContext } from '../types.js';

import { ReplyToInputSchema, createReplyToHandler, type ReplyToDeps } from './reply-to.js';

// ─────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────

const CALLER_ID = '01900000-0000-7000-8000-000000000aaa' as UUIDv7;
const CALLER_CELL_ID = '01900000-0000-7000-8000-000000000bbb' as UUIDv7;
const ORIGINAL_SENDER_ID = '01900000-0000-7000-8000-000000000ccc' as UUIDv7;
const ORIGINAL_MESSAGE_ID = '01900000-0000-7000-8000-000000000ddd' as UUIDv7;
const NEW_MESSAGE_ID = '01900000-0000-7000-8000-000000000eee' as UUIDv7;
const FIXED_SENT_AT = new Date('2026-05-01T12:00:00.000Z');
const FIXED_DELIVERED_AT = new Date('2026-05-01T12:00:00.500Z');

interface StubSenderState {
  receivedCalls: SendMessageInput[];
  rejectWith?: Error;
}

function buildStubSender(): { sender: Sender; state: StubSenderState } {
  const state: StubSenderState = { receivedCalls: [] };

  const sender: Sender = {
    sendMessage(input: SendMessageInput): Promise<SendResult> {
      state.receivedCalls.push(input);
      if (state.rejectWith) return Promise.reject(state.rejectWith);
      return Promise.resolve({
        messageId: NEW_MESSAGE_ID,
        sentAt: FIXED_SENT_AT,
        deliveredAt: FIXED_DELIVERED_AT,
        replayed: false,
      });
    },
  };

  return { sender, state };
}

interface StubRepoState {
  cell: Cell | null;
  message: Message | null;
}

function buildStubCellsRepo(initial: Partial<StubRepoState> = {}): {
  repo: CellsRepo;
  state: StubRepoState;
} {
  // Use `'key' in initial` rather than `??` so a caller that explicitly passes
  // `cell: null` keeps that null (per lesson PRY-005: `null ?? default = default`).
  const defaultCell: Cell = {
    id: CALLER_CELL_ID,
    hiveId: '01900000-0000-7000-8000-0000000000ff',
    ownerId: CALLER_ID,
    ownerKind: 'agent',
    state: 'active',
    createdAt: new Date('2026-04-01T00:00:00.000Z'),
    closedAt: null,
  };
  const state: StubRepoState = {
    cell: 'cell' in initial ? (initial.cell ?? null) : defaultCell,
    message: 'message' in initial ? (initial.message ?? null) : buildOriginalMessage(),
  };

  // Only the methods used by the reply-to handler are stubbed; the rest throw
  // on access so any incidental coupling surfaces immediately during tests.
  const repo = {
    findCellByOwner(ownerId: UUIDv7): Promise<Cell | null> {
      if (ownerId !== CALLER_ID) return Promise.resolve(null);
      return Promise.resolve(state.cell);
    },
    findMessageById(messageId: UUIDv7, cellId: UUIDv7): Promise<Message | null> {
      if (cellId !== CALLER_CELL_ID) return Promise.resolve(null);
      if (state.message === null) return Promise.resolve(null);
      if (state.message.id !== messageId) return Promise.resolve(null);
      return Promise.resolve(state.message);
    },
  } as unknown as CellsRepo;

  return { repo, state };
}

function buildOriginalMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: ORIGINAL_MESSAGE_ID,
    cellId: CALLER_CELL_ID,
    fromParticipantId: ORIGINAL_SENDER_ID,
    toParticipantId: CALLER_ID,
    type: 'request',
    body: 'hello',
    action: null,
    replyTo: null,
    ttl: null,
    sentAt: new Date('2026-04-30T12:00:00.000Z'),
    deliveredAt: new Date('2026-04-30T12:00:00.500Z'),
    readAt: null,
    state: 'delivered',
    expiredAt: null,
    ...overrides,
  };
}

function buildContext(): RequestContext {
  // The handler reads `ctx.identity.participantId` to look up the caller cell
  // and `ctx.requestId` to forward to the sender. Build a minimal stub.
  return {
    identity: { participantId: CALLER_ID },
    requestId: '01900000-0000-7000-8000-fffffffffff0',
  } as unknown as RequestContext;
}

function buildHandler(overrides: Partial<ReplyToDeps> = {}) {
  const sender = overrides.sender ?? buildStubSender().sender;
  const cellsRepo = overrides.cellsRepo ?? buildStubCellsRepo().repo;
  return createReplyToHandler({ sender, cellsRepo });
}

// ─────────────────────────────────────────────────────────────────────────
// Schema tests
// ─────────────────────────────────────────────────────────────────────────

describe('reply_to tool — input schema', () => {
  it('accepts the minimum required input (message_id, type, body)', () => {
    const result = ReplyToInputSchema.safeParse({
      message_id: ORIGINAL_MESSAGE_ID,
      type: 'response',
      body: 'thanks',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an input that includes a recipient field (recipient is derived, not supplied)', () => {
    const result = ReplyToInputSchema.safeParse({
      message_id: ORIGINAL_MESSAGE_ID,
      type: 'response',
      body: 'thanks',
      recipient: 'someone-else@hive.local',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a malformed message_id (not a UUID)', () => {
    const result = ReplyToInputSchema.safeParse({
      message_id: 'not-a-uuid',
      type: 'response',
      body: 'thanks',
    });
    expect(result.success).toBe(false);
  });

  it('accepts action: null per ADR-017 (.nullish())', () => {
    const result = ReplyToInputSchema.safeParse({
      message_id: ORIGINAL_MESSAGE_ID,
      type: 'response',
      body: 'thanks',
      action: null,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a populated action object', () => {
    const result = ReplyToInputSchema.safeParse({
      message_id: ORIGINAL_MESSAGE_ID,
      type: 'response',
      body: 'thanks',
      action: { kind: 'task.acknowledge' },
    });
    expect(result.success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Handler tests — Acceptance Criteria coverage
// ─────────────────────────────────────────────────────────────────────────

describe('reply_to tool — handler', () => {
  it('AC-1: happy path resolves recipientId from original.fromParticipantId and forwards to sendMessage', async () => {
    const { sender, state: senderState } = buildStubSender();
    const { repo } = buildStubCellsRepo();
    const handler = createReplyToHandler({ sender, cellsRepo: repo });

    const result = await handler(
      {
        message_id: ORIGINAL_MESSAGE_ID,
        type: 'response',
        body: 'reply body',
      },
      buildContext(),
    );

    expect(senderState.receivedCalls).toHaveLength(1);
    const captured = senderState.receivedCalls[0]!;
    expect(captured.recipientId).toBe(ORIGINAL_SENDER_ID);
    expect(captured.replyTo).toBe(ORIGINAL_MESSAGE_ID);
    expect(captured.body).toBe('reply body');
    expect(captured.type).toBe('response');

    expect(result).toEqual({
      message_id: NEW_MESSAGE_ID,
      sent_at: FIXED_SENT_AT.toISOString(),
      delivered_at: FIXED_DELIVERED_AT.toISOString(),
      replayed: false,
    });
  });

  it('AC-2: hard-fails with INVALID_INPUT { reply_target_not_in_caller_cell } when the message is not in the caller cell', async () => {
    const { sender, state: senderState } = buildStubSender();
    // message: null → findMessageById returns null
    const { repo } = buildStubCellsRepo({ message: null });
    const handler = createReplyToHandler({ sender, cellsRepo: repo });

    let captured: unknown;
    try {
      await handler(
        {
          message_id: ORIGINAL_MESSAGE_ID,
          type: 'response',
          body: 'reply body',
        },
        buildContext(),
      );
      throw new Error('expected handler to throw');
    } catch (err) {
      captured = err;
    }

    expect(captured).toBeInstanceOf(CellError);
    const cellErr = captured as CellError;
    expect(cellErr.code).toBe('INVALID_INPUT');
    expect(cellErr.subCode).toBe('reply_target_not_in_caller_cell');
    expect(senderState.receivedCalls).toHaveLength(0);
  });

  it('AC-2 (variant): hard-fails the same way when the caller has no cell at all (defensive)', async () => {
    const { sender, state: senderState } = buildStubSender();
    const { repo } = buildStubCellsRepo({ cell: null });
    const handler = createReplyToHandler({ sender, cellsRepo: repo });

    let captured: unknown;
    try {
      await handler(
        {
          message_id: ORIGINAL_MESSAGE_ID,
          type: 'response',
          body: 'reply body',
        },
        buildContext(),
      );
      throw new Error('expected handler to throw');
    } catch (err) {
      captured = err;
    }

    expect(captured).toBeInstanceOf(CellError);
    const cellErr = captured as CellError;
    expect(cellErr.code).toBe('INVALID_INPUT');
    expect(cellErr.subCode).toBe('reply_target_not_in_caller_cell');
    expect(senderState.receivedCalls).toHaveLength(0);
  });

  it('AC-3: forwards idempotency_key unchanged to sendMessage', async () => {
    const { sender, state: senderState } = buildStubSender();
    const handler = buildHandler({ sender });

    await handler(
      {
        message_id: ORIGINAL_MESSAGE_ID,
        type: 'response',
        body: 'reply body',
        idempotency_key: 'reply-once-K',
      },
      buildContext(),
    );

    expect(senderState.receivedCalls[0]!.idempotencyKey).toBe('reply-once-K');
  });

  it('AC-4: action: null is treated as "no action" (key absent from sendInput)', async () => {
    const { sender, state: senderState } = buildStubSender();
    const handler = buildHandler({ sender });

    await handler(
      {
        message_id: ORIGINAL_MESSAGE_ID,
        type: 'response',
        body: 'reply body',
        action: null,
      },
      buildContext(),
    );

    const captured = senderState.receivedCalls[0]!;
    expect('action' in captured).toBe(false);
  });

  it('AC-4 (regression): a populated action object propagates to sendInput', async () => {
    const { sender, state: senderState } = buildStubSender();
    const handler = buildHandler({ sender });

    await handler(
      {
        message_id: ORIGINAL_MESSAGE_ID,
        type: 'response',
        body: 'reply body',
        action: { kind: 'task.acknowledge', payload: { ok: true } },
      },
      buildContext(),
    );

    const captured = senderState.receivedCalls[0]!;
    expect(captured.action).toEqual({ kind: 'task.acknowledge', payload: { ok: true } });
  });

  it('AC-5: propagates RECIPIENT_UNREACHABLE from sendMessage when visibility denies the reply', async () => {
    const { sender, state: senderState } = buildStubSender();
    senderState.rejectWith = new CellError('RECIPIENT_UNREACHABLE', {
      subCode: 'visibility_denied',
    });
    const handler = buildHandler({ sender });

    let captured: unknown;
    try {
      await handler(
        {
          message_id: ORIGINAL_MESSAGE_ID,
          type: 'response',
          body: 'reply body',
        },
        buildContext(),
      );
      throw new Error('expected handler to propagate the sender error');
    } catch (err) {
      captured = err;
    }

    expect(captured).toBeInstanceOf(CellError);
    expect((captured as CellError).code).toBe('RECIPIENT_UNREACHABLE');
  });

  it('forwards ttl_ms as the ttl field on sendInput', async () => {
    const { sender, state: senderState } = buildStubSender();
    const handler = buildHandler({ sender });

    await handler(
      {
        message_id: ORIGINAL_MESSAGE_ID,
        type: 'response',
        body: 'reply body',
        ttl_ms: 60_000,
      },
      buildContext(),
    );

    expect(senderState.receivedCalls[0]!.ttl).toBe(60_000);
  });

  it('forwards ctx.requestId to sendInput.requestId for audit-log correlation', async () => {
    const { sender, state: senderState } = buildStubSender();
    const handler = buildHandler({ sender });

    await handler(
      {
        message_id: ORIGINAL_MESSAGE_ID,
        type: 'response',
        body: 'reply body',
      },
      buildContext(),
    );

    expect(senderState.receivedCalls[0]!.requestId).toBe('01900000-0000-7000-8000-fffffffffff0');
  });
});
