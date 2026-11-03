// resources/list and resources/read over the caller mailbox. The only readable URI is
// the one of the caller. Any other answers -32602 without telling a foreign mailbox
// from a missing one, and a caller without a Cell gets the same answer. Contents are mailbox metadata, never message bodies: bodies are
// read with read_mailbox, as untrusted data.

import type { McpServer } from '@modelcontextprotocol/server';

import { CellError } from '#domain/cells/index.js';
import type { CellsRepo } from '#domain/cells/index.js';
import type { Logger } from '#observability/logger.js';

import { requestContextFrom } from './auth-binding.js';
import { toProtocolError } from './error-mapper.js';
import type { RequestContext } from './types.js';

export interface MailboxResourceDeps {
  cellsRepo: CellsRepo;
  logger: Logger;
}

export function mailboxUri(cellId: string): string {
  return `hive://cells/${cellId}`;
}

async function callerCellId(
  deps: MailboxResourceDeps,
  ctx: RequestContext,
): Promise<string | null> {
  const cell = await deps.cellsRepo.findCellByOwner(ctx.identity.participantId);
  return cell?.id ?? null;
}

export function registerMailboxResources(server: McpServer, deps: MailboxResourceDeps): void {
  server.server.setRequestHandler('resources/list', async (_request, handlerCtx) => {
    try {
      const ctx = requestContextFrom(handlerCtx.http?.authInfo);
      const cellId = await callerCellId(deps, ctx);
      if (cellId === null) return { resources: [] };
      return {
        resources: [
          {
            uri: mailboxUri(cellId),
            name: 'mailbox',
            title: 'Mailbox',
            description: 'Unread count and senders of the caller mailbox.',
            mimeType: 'application/json',
          },
        ],
      };
    } catch (err) {
      throw toProtocolError(err, deps.logger);
    }
  });

  server.server.setRequestHandler('resources/read', async (request, handlerCtx) => {
    try {
      const ctx = requestContextFrom(handlerCtx.http?.authInfo);
      const cellId = await callerCellId(deps, ctx);
      const uri = cellId === null ? null : mailboxUri(cellId);
      if (cellId === null || request.params.uri !== uri) {
        throw new CellError('INVALID_INPUT', { subCode: 'mailbox_uri_not_owned' });
      }
      const summary = await deps.cellsRepo.summarizeUnreadForCell(cellId);
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: 'application/json',
            text: JSON.stringify({
              unread_count: summary.unreadCount,
              sender_ids: summary.distinctSenderIds,
            }),
          },
        ],
      };
    } catch (err) {
      throw toProtocolError(err, deps.logger);
    }
  });
}
