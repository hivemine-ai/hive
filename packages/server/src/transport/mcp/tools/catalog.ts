// Tool catalog for the MCP transport — Slice 0 declares 5 tools per the
// PRY-006 alcance. The 3 deferred tools (`reply_to`, `list_agents`,
// `get_agent_status`) are NOT registered here; clients see only the active
// catalog and never observe stub-not-implemented errors.

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
  | ReadMailboxWireOutput
  | MarkReadOutput
  | CheckUnreadMessagesOutput;

export function createToolCatalog(deps: ToolCatalogDeps): ToolDefinition[] {
  const getAgentConfig = createGetAgentConfigHandler(deps);
  const sendMessage = createSendMessageHandler(deps);
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
