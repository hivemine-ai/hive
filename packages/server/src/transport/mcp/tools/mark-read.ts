import { z } from 'zod';

import { CellError } from '#domain/cells/index.js';
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

export function createMarkReadHandler(deps: MarkReadDeps) {
  return async function markRead(
    input: MarkReadToolInput,
    ctx: RequestContext,
  ): Promise<MarkReadOutput> {
    for (const id of input.message_ids) {
      if (!UUID_V7_REGEX.test(id)) {
        throw new CellError('INVALID_INPUT', { subCode: 'message_id_malformed' });
      }
    }

    const result = await deps.reader.markRead({
      callerContext: ctx.identity,
      messageIds: input.message_ids.map((id) => id.toLowerCase()),
    });

    return { marked: result.marked, ignored: result.ignored };
  };
}
