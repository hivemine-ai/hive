import { z } from 'zod';

import type { Sender } from '#domain/cells/index.js';

import type { ReferenceResolver } from '../reference-resolver.js';
import type { RequestContext } from '../types.js';

export const SendMessageInputSchema = z
  .object({
    recipient: z.string().min(1),
    type: z.enum(['request', 'response', 'notification']),
    body: z.string().min(1),
    action: z.record(z.unknown()).optional(),
    reply_to: z.string().optional(),
    ttl_ms: z.number().int().positive().optional(),
    idempotency_key: z.string().optional(),
  })
  .strict();

export type SendMessageInput = z.infer<typeof SendMessageInputSchema>;

export interface SendMessageOutput {
  message_id: string;
  sent_at: string;
  delivered_at: string;
  replayed: boolean;
}

export interface SendMessageDeps {
  sender: Sender;
  resolver: ReferenceResolver;
}

export function createSendMessageHandler(deps: SendMessageDeps) {
  return async function sendMessage(
    input: SendMessageInput,
    ctx: RequestContext,
  ): Promise<SendMessageOutput> {
    const recipientId = await deps.resolver.resolveParticipantReference(
      input.recipient,
      ctx.identity,
    );

    const sendInput: Parameters<Sender['sendMessage']>[0] = {
      callerContext: ctx.identity,
      recipientId,
      type: input.type,
      body: input.body,
    };
    if (input.action !== undefined) sendInput.action = input.action;
    if (input.reply_to !== undefined) sendInput.replyTo = input.reply_to;
    if (input.ttl_ms !== undefined) sendInput.ttl = input.ttl_ms;
    if (input.idempotency_key !== undefined) sendInput.idempotencyKey = input.idempotency_key;

    const result = await deps.sender.sendMessage(sendInput);

    return {
      message_id: result.messageId,
      sent_at: result.sentAt.toISOString(),
      delivered_at: result.deliveredAt.toISOString(),
      replayed: result.replayed,
    };
  };
}
