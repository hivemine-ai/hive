import { z } from 'zod';

import { CellError } from '#domain/cells/index.js';
import type { CellsRepo } from '#domain/cells/index.js';

import type { RequestContext } from '../types.js';

export const CheckUnreadMessagesInputSchema = z.object({}).strict();
export type CheckUnreadMessagesInput = z.infer<typeof CheckUnreadMessagesInputSchema>;

export interface CheckUnreadMessagesOutput {
  unread_count: number;
  sender_ids: string[];
}

export interface CheckUnreadMessagesDeps {
  cellsRepo: CellsRepo;
}

export function createCheckUnreadMessagesHandler(deps: CheckUnreadMessagesDeps) {
  return async function checkUnreadMessages(
    _input: CheckUnreadMessagesInput,
    ctx: RequestContext,
  ): Promise<CheckUnreadMessagesOutput> {
    const cell = await deps.cellsRepo.findCellByOwner(ctx.identity.participantId);
    if (!cell) {
      throw new CellError('INTERNAL_INCONSISTENCY', { subCode: 'caller_has_no_cell' });
    }
    const summary = await deps.cellsRepo.summarizeUnreadForCell(cell.id);
    return {
      unread_count: summary.unreadCount,
      sender_ids: summary.distinctSenderIds,
    };
  };
}
