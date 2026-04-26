// Composition entry-point for the MCP transport: builds a per-session MCP
// server factory and wires the shared session-store + tool catalog.
//
// Per the SDK 1.29.0 design, `StreamableHTTPServerTransport` is single-session
// — a transport instance is "initialized" exactly once. To support multiple
// concurrent agents on the same fastify host, the http-host maintains a
// `Map<sessionId, { transport, mcpServer }>` and creates a fresh pair via
// the factory exposed by this module on every initialize request.
//
// The session-store is process-wide: it caches IdentityContext + Subscription
// keyed by the SDK's session-id. Tool handlers do `sessionStore.peek(sessionId)`
// to recover the identity for each call.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { v7 as uuidv7 } from 'uuid';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { AuthError, isAuthError } from '#domain/auth/index.js';
import type { ParticipantsReadRepo, Verifier, IdentityContext } from '#domain/auth/index.js';
import type { CellsRepo, Reader, Sender } from '#domain/cells/index.js';
import type { PresenceRegistry } from '#domain/notifications/index.js';
import type { Logger } from '#observability/logger.js';

import { mapDomainError, SessionError } from './error-mapper.js';
import { createReferenceResolver } from './reference-resolver.js';
import { createSessionStore, type SessionStore } from './session-store.js';
import { createMcpSubscriberHandle, type McpServerNotifier } from './subscriber-handle.js';
import { createToolCatalog, type ToolDefinition } from './tools/catalog.js';
import type { RequestContext, SessionState } from './types.js';

export interface McpTransportDeps {
  verifier: Verifier;
  participantsRepo: ParticipantsReadRepo;
  cellsRepo: CellsRepo;
  sender: Sender;
  reader: Reader;
  presenceRegistry: PresenceRegistry;
  logger: Logger;
  serverInfo?: { name: string; version: string };
  instructions?: string;
}

export interface McpTransport {
  /** Process-wide session store shared across all per-session McpServer instances. */
  sessionStore: SessionStore;
  /** Tool catalog (5 tools per Slice 0). */
  toolCatalog: ToolDefinition[];
  /** Build a new `McpServer` for a brand-new initialize request. */
  buildMcpServerForSession(): McpServer;
  /**
   * Bind the per-session McpServer so `ensureSessionFor` can build a
   * SubscriberHandle that uses it as the notifier. Called by the http-host
   * after `transport.handleRequest` completes the initialize handshake.
   */
  bindSessionServer(sessionId: string, mcpServer: McpServer): void;
  /** Inverse of `bindSessionServer`; called on session close. */
  unbindSessionServer(sessionId: string): void;
  /**
   * Lazy-create the session-store entry + Presence subscription for the given
   * sessionId. Idempotent — second call with the same sessionId is a no-op.
   * Calls `presenceRegistry.subscribe` and binds the resulting handle.
   */
  ensureSessionFor(sessionId: string, identity: IdentityContext): Promise<SessionState>;
}

const DEFAULT_SERVER_INFO = { name: 'hive', version: '0.1.0-dev' };
const DEFAULT_INSTRUCTIONS =
  'Hive v0.1 — agent messaging. Use get_agent_config to learn your identity, send_message to talk, check_unread_messages and read_mailbox to receive, mark_read to acknowledge.';

export function createMcpTransport(deps: McpTransportDeps): McpTransport {
  const sessionStore = createSessionStore();
  const resolver = createReferenceResolver({ participantsRepo: deps.participantsRepo });

  const toolCatalog = createToolCatalog({
    participantsRepo: deps.participantsRepo,
    cellsRepo: deps.cellsRepo,
    sender: deps.sender,
    reader: deps.reader,
    resolver,
  });

  // The notifier per session is created lazily inside ensureSessionFor; the
  // McpServer itself is created via buildMcpServerForSession below. We need a
  // reference to the per-session McpServer to wire `sendResourceUpdated`.
  // The fastify host stores this mapping (sessionId → { transport, mcpServer })
  // and provides it via ensureSessionFor's caller.
  //
  // We solve the wiring with a Map<sessionId, McpServer> that the http-host
  // populates on session creation and reads when ensureSessionFor fires.
  const serversBySession = new Map<string, McpServer>();

  function buildMcpServerForSession(): McpServer {
    const mcpServer = new McpServer(deps.serverInfo ?? DEFAULT_SERVER_INFO, {
      capabilities: {
        tools: {},
        resources: { subscribe: true, listChanged: false },
        prompts: {},
      },
      instructions: deps.instructions ?? DEFAULT_INSTRUCTIONS,
    });

    // Use the low-level Server API directly. The high-level `registerTool`
    // wraps this with parsed-args + zod-shape inference; for our 5 tools the
    // shape inference is brittle (empty `z.object({})` schemas don't round-trip
    // cleanly), so we own the dispatch and validation.
    const lowLevelServer = mcpServer.server;

    lowLevelServer.setRequestHandler(ListToolsRequestSchema, () => {
      return {
        tools: toolCatalog.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          // zod-to-json-schema accepts any ZodTypeAny; cast through to satisfy
          // the lib's stricter inferred parameter type.
          inputSchema: zodToJsonSchema(t.inputSchema as Parameters<typeof zodToJsonSchema>[0]),
        })),
      };
    });

    lowLevelServer.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const toolName = request.params.name;
      const tool = toolCatalog.find((t) => t.name === toolName);
      if (!tool) {
        throw new McpError(-32601, `tool not found: ${toolName}`);
      }

      const sessionId = extra.sessionId;
      if (sessionId === undefined) {
        throw mapToMcpError(new SessionError('SESSION_NOT_FOUND'), deps.logger);
      }

      let state: SessionState;
      try {
        sessionStore.requireIdentityFor(sessionId);
        sessionStore.touch(sessionId);
        const peeked = sessionStore.peek(sessionId);
        if (!peeked) throw new SessionError('SESSION_NOT_FOUND');
        state = peeked;
      } catch (err) {
        throw mapToMcpError(err, deps.logger);
      }

      // requireActiveSender middleware.
      try {
        const stateSummary = await deps.participantsRepo.getParticipantState(
          state.identity.participantId,
        );
        if (!stateSummary || stateSummary.state !== 'active') {
          throw mapToMcpError(new AuthError('PARTICIPANT_NOT_ACTIVE'), deps.logger);
        }
      } catch (err) {
        if (err instanceof McpError) throw err;
        throw mapToMcpError(err, deps.logger);
      }

      const ctx: RequestContext = {
        identity: state.identity,
        requestId: uuidv7(),
        sessionState: state,
      };

      try {
        const args = request.params.arguments ?? {};
        const result = await tool.handler(args, ctx);
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result as Record<string, unknown>,
        };
      } catch (err) {
        throw mapToMcpError(err, deps.logger);
      }
    });

    return mcpServer;
  }

  return {
    sessionStore,
    toolCatalog,
    buildMcpServerForSession,
    bindSessionServer(sessionId, mcpServer) {
      serversBySession.set(sessionId, mcpServer);
    },
    unbindSessionServer(sessionId) {
      serversBySession.delete(sessionId);
    },
    async ensureSessionFor(sessionId, identity) {
      const existing = sessionStore.peek(sessionId);
      if (existing && !existing.invalidated && existing.subscription !== null) {
        return existing;
      }

      const connectionId = uuidv7();
      const state = sessionStore.create({ sessionId, identity, connectionId });

      // Resolve the per-session McpServer that the http-host registered.
      const mcpServer = serversBySession.get(sessionId);
      if (!mcpServer) {
        // The http-host hasn't bound the per-session server yet (race), or this
        // is being called outside the normal flow. Skip subscription — next
        // tool call will retry.
        deps.logger.warn(
          { event: 'mcp_ensure_session_no_server', sessionId },
          'no per-session McpServer registered yet — subscription deferred',
        );
        return state;
      }

      const notifier: McpServerNotifier = {
        sendResourceUpdated: (params) => mcpServer.server.sendResourceUpdated(params),
      };
      // Pin the notifier in the SessionState so it stays GC-anchored for the
      // lifetime of the session — the SubscriberHandle holds it via WeakRef.
      // Without this anchor the notifier literal is eligible for collection
      // and `serverRef.deref()` would return undefined under memory pressure,
      // silently dropping Waggle notifications.
      state.notifierRef = notifier;

      const handle = createMcpSubscriberHandle({
        callerContext: identity,
        serverRef: new WeakRef(notifier),
        logger: deps.logger,
      });

      try {
        const subscription = await deps.presenceRegistry.subscribe({
          callerContext: identity,
          handle,
        });
        sessionStore.attachSubscription(sessionId, subscription);
      } catch (err) {
        sessionStore.close(sessionId);
        deps.logger.warn(
          {
            event: 'mcp_subscribe_failed',
            sessionId,
            err: err instanceof Error ? err.message : String(err),
          },
          'presence subscribe failed during ensureSessionFor',
        );
        throw err;
      }

      return state;
    },
  };
}

// ---------- helpers ----------

function mapToMcpError(err: unknown, logger?: Logger): McpError {
  if (err instanceof McpError) return err;

  if (isAuthError(err)) {
    const mapped = mapDomainError(err);
    if (logger) {
      logger.warn(
        {
          event: 'mcp_tool_error',
          domainCode: mapped.domainCode,
          subCode: mapped.subCode,
        },
        mapped.wire.message,
      );
    }
    return new McpError(mapped.wire.code, mapped.wire.message);
  }

  const mapped = mapDomainError(err);
  if (logger) {
    logger.warn(
      {
        event: 'mcp_tool_error',
        domainCode: mapped.domainCode,
        subCode: mapped.subCode,
      },
      mapped.wire.message,
    );
  }
  return new McpError(mapped.wire.code, mapped.wire.message);
}
