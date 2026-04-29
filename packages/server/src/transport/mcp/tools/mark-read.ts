import { z } from 'zod';

import type { Reader } from '#domain/cells/index.js';

import type { RequestContext } from '../types.js';

const DEFAULT_MAX_BATCH = 200;
const UUID_V7_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const MarkReadInputSchema = z
  .object({
    message_ids: z.array(z.string()).min(1).max(DEFAULT_MAX_BATCH, 'mark_read_batch_too_large'),
  })
  .strict();

export type MarkReadToolInput = z.infer<typeof MarkReadInputSchema>;

export interface MarkReadOutput {
  marked: string[];
  ignored: string[];
}

export interface MarkReadDeps {
  reader: Reader;
}

type Partitioned = { kind: 'valid'; normalized: string } | { kind: 'malformed'; original: string };

export function createMarkReadHandler(deps: MarkReadDeps) {
  return async function markRead(
    input: MarkReadToolInput,
    ctx: RequestContext,
  ): Promise<MarkReadOutput> {
    // Partition input ids into "valid UUIDv7" (forwarded to the reader) and
    // "malformed" (skipped, no DB roundtrip — appended to `ignored` per the
    // existing privacy-preserving catch-all contract: callers cannot tell
    // "malformed" from "unknown" / "from another cell" / "already read").
    // Order of input is preserved across the merged response so callers can
    // correlate offsets if they want to, without leaking shape via diff.
    const partition: Partitioned[] = input.message_ids.map((id) =>
      UUID_V7_REGEX.test(id)
        ? { kind: 'valid', normalized: id.toLowerCase() }
        : { kind: 'malformed', original: id },
    );

    const validNormalized: string[] = [];
    for (const entry of partition) {
      if (entry.kind === 'valid') validNormalized.push(entry.normalized);
    }

    let markedQueue: readonly string[] = [];
    if (validNormalized.length > 0) {
      const result = await deps.reader.markRead({
        callerContext: ctx.identity,
        messageIds: validNormalized,
      });
      markedQueue = result.marked;
    }

    // Merge by walking partition in input order and consuming the domain
    // result as ordered queues. Domain pushes ids into `marked` / `ignored`
    // in valid-input order (one per for-loop iteration in `read.ts::markRead`),
    // so the next valid entry's bucket is always the head of one of the two
    // queues. Membership-by-Set would mis-handle duplicate valid ids
    // (e.g. `[A, A]` with A known unread → domain returns marked:[A], ignored:[A];
    // a Set-based merge would emit marked:[A, A] instead of marked:[A], ignored:[A]).
    const marked: string[] = [];
    const ignored: string[] = [];
    let mIdx = 0;
    for (const entry of partition) {
      if (entry.kind === 'malformed') {
        ignored.push(entry.original);
        continue;
      }
      if (mIdx < markedQueue.length && markedQueue[mIdx] === entry.normalized) {
        marked.push(entry.normalized);
        mIdx++;
      } else {
        ignored.push(entry.normalized);
      }
    }

    return { marked, ignored };
  };
}
