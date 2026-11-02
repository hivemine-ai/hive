// Builds the SDK server instance for one request. `createMcpHandler` calls the factory
// once per request and the instance dies with it, so nothing here keeps per-caller
// state: the identity of every handler comes from the authInfo of the request in
// progress.
//
// Tools use the low-level request handlers: Hive owns input validation so a bad input
// stays the JSON-RPC -32602 of the error table, instead of the tool-result error the
// high-level registerTool would produce.

import { McpServer, ProtocolError } from '@modelcontextprotocol/server';
import { HIVE_VERSION } from '@hive/shared';
import { z } from 'zod';

import { AuthError } from '#domain/auth/index.js';
import type { ParticipantsReadRepo } from '#domain/auth/index.js';
import type { CellsRepo, Reader, Sender } from '#domain/cells/index.js';
import type { PresenceRegistry } from '#domain/notifications/index.js';
import type { VisibilityEngine } from '#domain/visibility/index.js';
import type { Logger } from '#observability/logger.js';

import { requestContextFrom } from './auth-binding.js';
import { MCP_ERR_INVALID_PARAMS } from './error-codes.js';
import { toProtocolError } from './error-mapper.js';
import { createReferenceResolver } from './reference-resolver.js';
import { registerMailboxResources } from './resources.js';
import { createToolCatalog, type ToolDefinition } from './tools/catalog.js';

export interface McpTransportDeps {
  participantsRepo: ParticipantsReadRepo;
  cellsRepo: CellsRepo;
  sender: Sender;
  reader: Reader;
  visibilityEngine: VisibilityEngine;
  presenceRegistry: PresenceRegistry;
  logger: Logger;
  serverInfo?: { name: string; version: string };
  instructions?: string;
  /** Hard cap server-side for `list_agents.pagination.limit`. From HIVE_MCP_LIST_AGENTS_MAX_PAGE_SIZE. */
  listAgentsMaxPageSize: number;
}

export interface McpTransport {
  /** Tool catalog (the 8 tools of the product spec, in a deterministic order). */
  toolCatalog: ToolDefinition[];
  /** Factory for `createMcpHandler`: one fresh server instance per request. */
  buildServer(): McpServer;
  /** Identity stamped on the frames the listen edge writes. */
  serverInfo: { name: string; version: string };
}

const DEFAULT_SERVER_INFO = { name: 'hive', version: HIVE_VERSION };
const DEFAULT_INSTRUCTIONS =
  'Hive — agent messaging. Use get_agent_config to learn your identity, list_agents to discover others, get_agent_status to check who is reachable by push, send_message or reply_to to talk, check_unread_messages and read_mailbox to receive, mark_read to acknowledge.';

// Provisional values from the tech spec. The catalog is identical for every caller;
// the mailbox depends on the caller, so it must not be cached across participants.
const CACHE_HINTS = {
  'tools/list': { ttlMs: 60_000, cacheScope: 'public' },
  'resources/list': { ttlMs: 0, cacheScope: 'private' },
  'resources/read': { ttlMs: 0, cacheScope: 'private' },
} as const;

export function createMcpTransport(deps: McpTransportDeps): McpTransport {
  const serverInfo = deps.serverInfo ?? DEFAULT_SERVER_INFO;
  const resolver = createReferenceResolver({ participantsRepo: deps.participantsRepo });

  const toolCatalog = createToolCatalog({
    participantsRepo: deps.participantsRepo,
    cellsRepo: deps.cellsRepo,
    sender: deps.sender,
    reader: deps.reader,
    resolver,
    visibilityEngine: deps.visibilityEngine,
    presenceRegistry: deps.presenceRegistry,
    maxPageSize: deps.listAgentsMaxPageSize,
  });

  const toolList = toolCatalog.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: z.toJSONSchema(t.inputSchema, { io: 'input' }) as {
      type: 'object';
      [key: string]: unknown;
    },
  }));

  function buildServer(): McpServer {
    const mcpServer = new McpServer(serverInfo, {
      instructions: deps.instructions ?? DEFAULT_INSTRUCTIONS,
      cacheHints: CACHE_HINTS,
    });
    const lowLevelServer = mcpServer.server;

    // Not through the McpServer constructor: there, these capabilities install the SDK
    // default handlers and declare listChanged, a notification Hive never emits.
    lowLevelServer.registerCapabilities({ tools: {}, resources: { subscribe: true } });

    lowLevelServer.setRequestHandler('tools/list', () => ({ tools: toolList }));

    lowLevelServer.setRequestHandler('tools/call', async (request, handlerCtx) => {
      const toolName = request.params.name;
      const tool = toolCatalog.find((t) => t.name === toolName);
      if (!tool) {
        throw new ProtocolError(MCP_ERR_INVALID_PARAMS, `tool not found: ${toolName}`);
      }

      try {
        const ctx = requestContextFrom(handlerCtx.http?.authInfo);
        const participantId = ctx.identity.participantId;

        // requireActiveSender middleware.
        const stateSummary = await deps.participantsRepo.getParticipantState(participantId);
        if (!stateSummary || stateSummary.state !== 'active') {
          throw new AuthError('PARTICIPANT_NOT_ACTIVE');
        }

        const result = await tool.handler(request.params.arguments ?? {}, ctx);
        deps.logger.info(
          { event: 'mcp_tool_dispatch_success', tool: toolName, participantId },
          'mcp tool dispatch success',
        );
        return lowLevelServer.projectCallToolResult(
          {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            structuredContent: result,
          },
          undefined,
        );
      } catch (err) {
        throw toProtocolError(err, deps.logger);
      }
    });

    registerMailboxResources(mcpServer, { cellsRepo: deps.cellsRepo, logger: deps.logger });

    return mcpServer;
  }

  return { toolCatalog, buildServer, serverInfo };
}
