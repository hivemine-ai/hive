import { z } from 'zod';

import { CellError } from '#domain/cells/index.js';
import type { CellsRepo, Sender } from '#domain/cells/index.js';

import type { RequestContext } from '../types.js';

export const ReplyToInputSchema = z
  .object({
    message_id: z.string().uuid(),
    type: z.enum(['request', 'response', 'notification']),
    body: z.string().min(1),
    action: z.record(z.unknown()).nullish(),
    ttl_ms: z.number().int().positive().optional(),
    idempotency_key: z.string().optional(),
  })
  .strict();

export type ReplyToInput = z.infer<typeof ReplyToInputSchema>;

export interface ReplyToOutput {
  message_id: string;
  sent_at: string;
  delivered_at: string;
  replayed: boolean;
}

export interface ReplyToDeps {
  sender: Sender;
  cellsRepo: CellsRepo;
}

export function createReplyToHandler(deps: ReplyToDeps) {
  return async function replyTo(input: ReplyToInput, ctx: RequestContext): Promise<ReplyToOutput> {
    const messageId = input.message_id;
    const callerCell = await deps.cellsRepo.findCellByOwner(ctx.identity.participantId);

    // Hard-fail uniformly when either the caller has no cell or the message is
    // not in their cell. Both paths leak the same subCode so the wire response
    // is indistinguishable to the caller (privacy: cannot probe whether a
    // message exists in a different cell). Tech spec § Tool 5 + product
    // [[API MCP — Tools]] § Tool 5 ("the referenced message must be in the
    // caller cell"). The "soft reference" note in the product spec applies to
    // a recipient receiving a dangling reply_to, not to the caller inventing
    // ids.
    const original =
      callerCell === null ? null : await deps.cellsRepo.findMessageById(messageId, callerCell.id);
    if (original === null) {
      throw new CellError('INVALID_INPUT', { subCode: 'reply_target_not_in_caller_cell' });
    }

    const sendInput: Parameters<Sender['sendMessage']>[0] = {
      callerContext: ctx.identity,
      recipientId: original.fromParticipantId,
      type: input.type,
      body: input.body,
      replyTo: messageId,
    };
    if (input.action != null) sendInput.action = input.action;
    if (input.ttl_ms !== undefined) sendInput.ttl = input.ttl_ms;
    if (input.idempotency_key !== undefined) sendInput.idempotencyKey = input.idempotency_key;
    sendInput.requestId = ctx.requestId;

    const result = await deps.sender.sendMessage(sendInput);

    return {
      message_id: result.messageId,
      sent_at: result.sentAt.toISOString(),
      delivered_at: result.deliveredAt.toISOString(),
      replayed: result.replayed,
    };
  };
}
