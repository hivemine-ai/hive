import { z } from 'zod';

import { CellError } from '#domain/cells/index.js';
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
        state: z.enum(['delivered', 'read', 'unread']).optional(),
        from: z.string().optional(),
        type: z.enum(['request', 'response', 'notification']).optional(),
      })
      .optional(),
    pagination: z
      .object({
        cursor: z
          .object({
            delivered_at: z.string().datetime(),
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

export function createReadMailboxHandler(deps: ReadMailboxDeps) {
  return async function readMailbox(
    input: ReadMailboxToolInput,
    ctx: RequestContext,
  ): Promise<ReadMailboxWireOutput> {
    const filter: ReadMailboxFilter = {};
    let pageLimit = DEFAULT_PAGE_LIMIT;

    if (input.filter !== undefined) {
      // 'unread' (product) maps to 'delivered' state-side; both 'unread' and
      // 'delivered' values from the wire produce { state: 'delivered' } per the
      // tech spec § Tool 3 read_mailbox mapping.
      if (input.filter.state === 'unread' || input.filter.state === 'delivered') {
        filter.state = 'delivered';
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
        filter.from = await deps.resolver.resolveParticipantReference(
          input.filter.from,
          ctx.identity,
        );
      }
    }

    const readInput: ReadMailboxInput = {
      callerContext: ctx.identity,
      filter,
    };

    if (input.pagination !== undefined) {
      if (input.pagination.limit !== undefined) pageLimit = input.pagination.limit;

      if (input.pagination.cursor !== undefined) {
        const parsedDate = new Date(input.pagination.cursor.delivered_at);
        if (Number.isNaN(parsedDate.getTime())) {
          throw new CellError('INVALID_INPUT', { subCode: 'cursor_delivered_at_invalid' });
        }
        readInput.pagination = {
          cursor: {
            deliveredAt: parsedDate,
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
    return adaptMailbox(messages, pageLimit);
  };
}
