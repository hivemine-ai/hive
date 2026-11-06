import { z } from 'zod';

import { CellError, isCellError } from '#domain/cells/index.js';
import type { Reader, ReadMailboxFilter, ReadMailboxInput } from '#domain/cells/index.js';

import type { ReferenceResolver } from '../reference-resolver.js';
import type { RequestContext } from '../types.js';
import {
  adaptMailbox,
  type ReadMailboxWireOutput,
} from '#transport/mcp/views/message-view-wire.js';

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;

export const ReadMailboxInputSchema = z
  .object({
    filter: z
      .object({
        state: z.enum(['stored', 'read', 'unread']).optional(),
        from: z.string().optional(),
        type: z.enum(['request', 'response', 'notification']).optional(),
      })
      .optional(),
    pagination: z
      .object({
        cursor: z
          .object({
            stored_at: z.string().datetime(),
            message_id: z.string(),
          })
          .optional(),
        limit: z.number().int().min(1).max(MAX_PAGE_LIMIT).optional(),
      })
      .optional(),
  })
  .strict();

export type ReadMailboxToolInput = z.infer<typeof ReadMailboxInputSchema>;

export interface ReadMailboxDeps {
  reader: Reader;
  resolver: ReferenceResolver;
}

async function resolveSender(
  resolver: ReferenceResolver,
  reference: string,
  ctx: RequestContext,
): Promise<string> {
  try {
    return await resolver.resolveParticipantReference(reference, ctx.identity);
  } catch (err) {
    if (isCellError(err) && err.subCode === 'reference_unresolved') {
      throw new CellError('INVALID_INPUT', { subCode: 'reference_unresolved' });
    }
    throw err;
  }
}

export function createReadMailboxHandler(deps: ReadMailboxDeps) {
  return async function readMailbox(
    input: ReadMailboxToolInput,
    ctx: RequestContext,
  ): Promise<ReadMailboxWireOutput> {
    const filter: ReadMailboxFilter = {};
    let pageLimit = DEFAULT_PAGE_LIMIT;

    if (input.filter !== undefined) {
      // 'unread' (product) maps to 'stored' state-side; both 'unread' and
      // 'stored' values from the wire produce { state: 'stored' } per the
      // tech spec § Tool 3 read_mailbox mapping.
      if (input.filter.state === 'unread' || input.filter.state === 'stored') {
        filter.state = 'stored';
      } else if (input.filter.state === 'read') {
        filter.state = 'read';
      }

      if (input.filter.type !== undefined) filter.types = [input.filter.type];

      if (input.filter.from !== undefined) {
        // Resolve any human-readable reference (UUID / email / "self") to
        // canonical UUIDv7 and apply it as a sender predicate downstream.
        // Surfaces INVALID_INPUT / RECIPIENT_UNREACHABLE early when the
        // reference does not parse or does not resolve to a participant.
        // Closes INC-2026-001 #1 (PRY-020) — the previous implementation
        // resolved the reference but discarded the result, leaking ALL
        // mail to a caller that thought it was filtering by sender.
        //
        // Unlike list_agents there is no empty list that uniform privacy would justify
        // here: the filter applies to the caller mailbox, so an unresolved reference is
        // a bad input.
        filter.from = await resolveSender(deps.resolver, input.filter.from, ctx);
      }
    }

    const readInput: ReadMailboxInput = {
      callerContext: ctx.identity,
      filter,
    };

    if (input.pagination !== undefined) {
      if (input.pagination.limit !== undefined) pageLimit = input.pagination.limit;

      if (input.pagination.cursor !== undefined) {
        const parsedDate = new Date(input.pagination.cursor.stored_at);
        if (Number.isNaN(parsedDate.getTime())) {
          throw new CellError('INVALID_INPUT', { subCode: 'cursor_stored_at_invalid' });
        }
        readInput.pagination = {
          cursor: {
            storedAt: parsedDate,
            messageId: input.pagination.cursor.message_id,
          },
          limit: pageLimit,
        };
      } else {
        readInput.pagination = { cursor: null, limit: pageLimit };
      }
    } else {
      readInput.pagination = { cursor: null, limit: pageLimit };
    }

    const messages = await deps.reader.readMailbox(readInput);
    return adaptMailbox(messages, pageLimit, ctx.identity.hiveId);
  };
}
