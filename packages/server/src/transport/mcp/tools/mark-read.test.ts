import { describe, expect, it } from 'vitest';

import { CellError } from '#domain/cells/index.js';
import type { MarkReadInput, MarkReadResult, Reader } from '#domain/cells/index.js';

import type { RequestContext } from '../types.js';

import { createMarkReadHandler } from './mark-read.js';

// ─────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────

const VALID_A = '01900000-0000-7000-8000-000000000001';
const VALID_B = '01900000-0000-7000-8000-000000000002';
const VALID_C = '01900000-0000-7000-8000-000000000003';
const VALID_UNKNOWN = '01900000-0000-7000-8000-00000000aaaa';
const MALFORMED_GARBAGE = 'not-a-uuid-at-all';
const MALFORMED_TRUNCATED = '01900000-0000-7000-8000-00000000000';
const MALFORMED_NON_HEX = '01900000-0000-7000-8000-zzzzzzzzzzzz';
const MALFORMED_V4 = '01900000-0000-4000-8000-000000000001';

interface StubReaderState {
  receivedCalls: MarkReadInput[];
  knownReadable: Set<string>;
}

function buildStubReader(knownReadable: string[] = []): {
  reader: Reader;
  state: StubReaderState;
} {
  const state: StubReaderState = {
    receivedCalls: [],
    knownReadable: new Set(knownReadable.map((id) => id.toLowerCase())),
  };

  const reader: Reader = {
    readMailbox() {
      return Promise.reject(new Error('readMailbox stub not used in this test'));
    },
    markRead(input: MarkReadInput): Promise<MarkReadResult> {
      state.receivedCalls.push(input);
      const marked: string[] = [];
      const ignored: string[] = [];
      for (const id of input.messageIds) {
        if (state.knownReadable.has(id)) {
          marked.push(id);
        } else {
          ignored.push(id);
        }
      }
      return Promise.resolve({ marked, ignored });
    },
  };
  return { reader, state };
}

function buildContext(): RequestContext {
  // Minimal stub — the tool layer only forwards `ctx.identity` to the reader,
  // and the stub reader ignores it. Type-casting via unknown avoids building
  // out the full IdentityContext / SessionState surface for these unit tests.
  return {} as unknown as RequestContext;
}

// ─────────────────────────────────────────────────────────────────────────
// Tests — PRY-022 fix: malformed UUIDv7 ids land in `ignored` instead of
// failing the entire batch with INVALID_INPUT { subCode: 'message_id_malformed' }.
// Privacy-equivalent to unknown-ids per the existing `ignored` contract
// (no leak of "malformed" vs "unknown" — caller cannot distinguish).
// ─────────────────────────────────────────────────────────────────────────

describe('mark_read tool — id validation behaviour (PRY-022)', () => {
  it('AC4 (regression): batch with N-1 valid ids + 1 malformed id succeeds; malformed lands in ignored', async () => {
    const { reader, state } = buildStubReader([VALID_A, VALID_B, VALID_C]);
    const handler = createMarkReadHandler({ reader });

    const result = await handler(
      { message_ids: [VALID_A, VALID_B, MALFORMED_GARBAGE, VALID_C] },
      buildContext(),
    );

    expect(result.marked).toEqual([VALID_A, VALID_B, VALID_C]);
    expect(result.ignored).toEqual([MALFORMED_GARBAGE]);
    // Reader received only the valid ids, never the malformed one.
    expect(state.receivedCalls).toHaveLength(1);
    expect(state.receivedCalls[0]?.messageIds).toEqual([VALID_A, VALID_B, VALID_C]);
  });

  it('AC2: batch with all malformed ids succeeds with marked:[] and ignored containing every input', async () => {
    const { reader, state } = buildStubReader();
    const handler = createMarkReadHandler({ reader });

    const result = await handler(
      { message_ids: [MALFORMED_GARBAGE, MALFORMED_TRUNCATED, MALFORMED_NON_HEX, MALFORMED_V4] },
      buildContext(),
    );

    expect(result.marked).toEqual([]);
    expect(result.ignored).toEqual([
      MALFORMED_GARBAGE,
      MALFORMED_TRUNCATED,
      MALFORMED_NON_HEX,
      MALFORMED_V4,
    ]);
    // Reader is never invoked when all ids are malformed (no DB roundtrip).
    expect(state.receivedCalls).toHaveLength(0);
  });

  it('AC3: mixed batch (malformed + unknown valid + known) preserves input order in `ignored`', async () => {
    const { reader } = buildStubReader([VALID_A]);
    const handler = createMarkReadHandler({ reader });

    const result = await handler(
      { message_ids: [VALID_UNKNOWN, MALFORMED_GARBAGE, VALID_A] },
      buildContext(),
    );

    expect(result.marked).toEqual([VALID_A]);
    // Order preserved: unknown-valid first (input pos 0), malformed second (input pos 1).
    expect(result.ignored).toEqual([VALID_UNKNOWN, MALFORMED_GARBAGE]);
  });

  it('AC1 (regression): batch with all valid but unknown ids → all in ignored, no error', async () => {
    const { reader, state } = buildStubReader();
    const handler = createMarkReadHandler({ reader });

    const result = await handler(
      { message_ids: [VALID_A, VALID_B, VALID_UNKNOWN] },
      buildContext(),
    );

    expect(result.marked).toEqual([]);
    expect(result.ignored).toEqual([VALID_A, VALID_B, VALID_UNKNOWN]);
    expect(state.receivedCalls).toHaveLength(1);
    expect(state.receivedCalls[0]?.messageIds).toEqual([VALID_A, VALID_B, VALID_UNKNOWN]);
  });

  it('AC6: malformed ids are returned verbatim in `ignored` (no normalization, no leak via shape)', async () => {
    const { reader } = buildStubReader();
    const handler = createMarkReadHandler({ reader });

    const result = await handler(
      { message_ids: [MALFORMED_GARBAGE, MALFORMED_NON_HEX] },
      buildContext(),
    );

    // Caller cannot distinguish "malformed" from "unknown" — both land in `ignored`
    // in input order. The malformed ids appear verbatim (no lowercase, no trim)
    // because they are not UUIDv7 and the input was already opaque to the server.
    expect(result.ignored).toEqual([MALFORMED_GARBAGE, MALFORMED_NON_HEX]);
  });

  it('regression: case-insensitive UUIDv7 — uppercase valid id matches the stub-known lowercase id', async () => {
    const { reader, state } = buildStubReader([VALID_A]);
    const handler = createMarkReadHandler({ reader });
    const upper = VALID_A.toUpperCase();

    const result = await handler({ message_ids: [upper] }, buildContext());

    expect(result.marked).toEqual([VALID_A]);
    expect(result.ignored).toEqual([]);
    // The reader received the lowercased id (existing convention preserved).
    expect(state.receivedCalls[0]?.messageIds).toEqual([VALID_A]);
  });

  it('does NOT throw INVALID_INPUT when the only id is malformed (regression of the original bug)', async () => {
    const { reader } = buildStubReader();
    const handler = createMarkReadHandler({ reader });

    // Before PRY-022 this threw `CellError('INVALID_INPUT', { subCode: 'message_id_malformed' })`
    // and the entire batch was rejected with -32602 at the JSON-RPC layer.
    await expect(handler({ message_ids: [MALFORMED_GARBAGE] }, buildContext())).resolves.toEqual({
      marked: [],
      ignored: [MALFORMED_GARBAGE],
    });
  });

  it('propagates reader errors (e.g. INTERNAL_INCONSISTENCY when caller has no Cell) for valid-only batches', async () => {
    // Replace the stub markRead with one that throws — verifies the handler
    // does not swallow downstream errors when its partition/merge work succeeds.
    const reader: Reader = {
      readMailbox() {
        return Promise.reject(new Error('not used'));
      },
      markRead() {
        return Promise.reject(
          new CellError('INTERNAL_INCONSISTENCY', { subCode: 'caller_has_no_cell' }),
        );
      },
    };
    const handler = createMarkReadHandler({ reader });

    await expect(handler({ message_ids: [VALID_A] }, buildContext())).rejects.toMatchObject({
      code: 'INTERNAL_INCONSISTENCY',
      subCode: 'caller_has_no_cell',
    });
  });

  it('preserves prior behaviour for duplicate valid ids — first occurrence marked, second occurrence ignored', async () => {
    // Domain returns `marked: [A]` then `ignored: [A]` because the second
    // UPDATE finds `read_at IS NOT NULL` after the first UPDATE in the same
    // call. The tool layer must reproduce that 1:1 mapping per input position.
    // A naive Set-based membership merge would emit `marked: [A, A]` because
    // `Set.has(A)` is true for both occurrences.
    const stubKnown = new Set([VALID_A]);
    const reader: Reader = {
      readMailbox() {
        return Promise.reject(new Error('not used'));
      },
      markRead(input: MarkReadInput): Promise<MarkReadResult> {
        const marked: string[] = [];
        const ignored: string[] = [];
        const seenInThisCall = new Set<string>();
        for (const id of input.messageIds) {
          if (stubKnown.has(id) && !seenInThisCall.has(id)) {
            marked.push(id);
            seenInThisCall.add(id);
          } else {
            ignored.push(id);
          }
        }
        return Promise.resolve({ marked, ignored });
      },
    };
    const handler = createMarkReadHandler({ reader });

    const result = await handler({ message_ids: [VALID_A, VALID_A] }, buildContext());

    expect(result.marked).toEqual([VALID_A]);
    expect(result.ignored).toEqual([VALID_A]);
  });

  it('preserves prior behaviour for duplicate unknown valid ids — both occurrences ignored, no marked dups', async () => {
    const { reader } = buildStubReader(); // no known ids
    const handler = createMarkReadHandler({ reader });

    const result = await handler({ message_ids: [VALID_UNKNOWN, VALID_UNKNOWN] }, buildContext());

    expect(result.marked).toEqual([]);
    expect(result.ignored).toEqual([VALID_UNKNOWN, VALID_UNKNOWN]);
  });

  it('does NOT call the reader when the batch is entirely malformed (no DB roundtrip cost)', async () => {
    const { reader, state } = buildStubReader();
    const handler = createMarkReadHandler({ reader });

    await handler({ message_ids: [MALFORMED_GARBAGE, MALFORMED_TRUNCATED] }, buildContext());

    expect(state.receivedCalls).toHaveLength(0);
  });
});
