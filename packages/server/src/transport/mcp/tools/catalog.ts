// Tool catalog for the MCP transport. Slice 0 (PRY-006) declared 5 tools;
// Slice 2 adds the 3 deferred tools one at a time. PRY-028 adds `reply_to`,
// bringing the catalog to 6/8. The remaining 2 (`list_agents`,
// `get_agent_status`) land in PRY-029 and PRY-030.

import type { z } from 'zod';

import type { RequestContext } from '../types.js';

import {
  CheckUnreadMessagesInputSchema,
  type CheckUnreadMessagesOutput,
  createCheckUnreadMessagesHandler,
  type CheckUnreadMessagesDeps,
} from './check-unread-messages.js';
import {
  GetAgentConfigInputSchema,
  createGetAgentConfigHandler,
  type GetAgentConfigDeps,
} from './get-agent-config.js';
import {
  MarkReadInputSchema,
  type MarkReadOutput,
  createMarkReadHandler,
  type MarkReadDeps,
} from './mark-read.js';
import {
  ReadMailboxInputSchema,
  createReadMailboxHandler,
  type ReadMailboxDeps,
} from './read-mailbox.js';
import {
  ReplyToInputSchema,
  type ReplyToOutput,
  createReplyToHandler,
  type ReplyToDeps,
} from './reply-to.js';
import {
  SendMessageInputSchema,
  type SendMessageOutput,
  createSendMessageHandler,
  type SendMessageDeps,
} from './send-message.js';
import type { AgentConfigView } from '../views/agent-config-view.js';
import type { ReadMailboxWireOutput } from '../views/message-view-wire.js';

export type ToolName =
  | 'get_agent_config'
  | 'send_message'
  | 'reply_to'
  | 'read_mailbox'
  | 'mark_read'
  | 'check_unread_messages';

export interface ToolDefinition {
  name: ToolName;
  title: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  // The handler receives the parsed input + RequestContext; it returns an
  // arbitrary serialisable value that the SDK marshals as the tool result.
  handler: (input: unknown, ctx: RequestContext) => Promise<unknown>;
}

export interface ToolCatalogDeps
  extends
    GetAgentConfigDeps,
    SendMessageDeps,
    ReplyToDeps,
    ReadMailboxDeps,
    MarkReadDeps,
    CheckUnreadMessagesDeps {}

/**
 * Output type union — convenience export for callers that want to type-narrow
 * the response. Each tool's return type appears here verbatim.
 */
export type ToolOutput =
  | AgentConfigView
  | SendMessageOutput
  | ReplyToOutput
  | ReadMailboxWireOutput
  | MarkReadOutput
  | CheckUnreadMessagesOutput;

export function createToolCatalog(deps: ToolCatalogDeps): ToolDefinition[] {
  const getAgentConfig = createGetAgentConfigHandler(deps);
  const sendMessage = createSendMessageHandler(deps);
  const replyTo = createReplyToHandler(deps);
  const readMailbox = createReadMailboxHandler(deps);
  const markRead = createMarkReadHandler(deps);
  const checkUnreadMessages = createCheckUnreadMessagesHandler(deps);

  return [
    {
      name: 'get_agent_config',
      title: 'Get agent config',
      description: 'Returns the calling participant identity, hive, colony, and capabilities.',
      inputSchema: GetAgentConfigInputSchema,
      handler: async (input, ctx) => getAgentConfig(GetAgentConfigInputSchema.parse(input), ctx),
    },
    {
      name: 'send_message',
      title: 'Send message',
      description:
        'Sends a message from the caller to the recipient (referenced by id, email, agent reference, or "self").',
      inputSchema: SendMessageInputSchema,
      handler: async (input, ctx) => sendMessage(SendMessageInputSchema.parse(input), ctx),
    },
    {
      name: 'reply_to',
      title: 'Reply to message',
      description:
        'Sends a reply to the original sender of a message in the caller cell. Resolves the recipient from the referenced message and propagates reply_to.',
      inputSchema: ReplyToInputSchema,
      handler: async (input, ctx) => replyTo(ReplyToInputSchema.parse(input), ctx),
    },
    {
      name: 'read_mailbox',
      title: 'Read mailbox',
      description:
        'Reads messages from the caller cell, optionally filtered by state/type/sender, with keyset pagination.',
      inputSchema: ReadMailboxInputSchema,
      handler: async (input, ctx) => readMailbox(ReadMailboxInputSchema.parse(input), ctx),
    },
    {
      name: 'mark_read',
      title: 'Mark messages read',
      description: 'Marks a batch of message ids as read. Returns marked + ignored ids.',
      inputSchema: MarkReadInputSchema,
      handler: async (input, ctx) => markRead(MarkReadInputSchema.parse(input), ctx),
    },
    {
      name: 'check_unread_messages',
      title: 'Check unread messages',
      description: 'Returns the count of delivered (unread) messages and the distinct senders.',
      inputSchema: CheckUnreadMessagesInputSchema,
      handler: async (input, ctx) =>
        checkUnreadMessages(CheckUnreadMessagesInputSchema.parse(input), ctx),
    },
  ];
}

export function lookupTool(catalog: ToolDefinition[], name: string): ToolDefinition | undefined {
  return catalog.find((t) => t.name === name);
}
