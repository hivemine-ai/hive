// fastify HTTP host for the MCP transport. Wires:
//   - POST /mcp        → per-session StreamableHTTPServerTransport (SDK)
//   - GET  /mcp        → SSE stream for server-initiated notifications (SDK)
//   - DELETE /mcp      → session termination (SDK)
//   - GET  /healthz    → 200 always (liveness)
//   - GET  /readyz     → 200 if DB ping succeeds within timeout, else 503
//   - GET  /.well-known/jwks.json → public JWKS from KeypairStore
//
// Per the SDK 1.29.0 design, `StreamableHTTPServerTransport` is single-session
// — one transport instance == one initialized session. To support multiple
// concurrent agents on the same fastify host, the http-host maintains a
// `Map<sessionId, { transport, mcpServer }>` and creates a fresh pair on
// every initialize request. The `mcp-session-id` header threads sessionId
// across subsequent requests.
//
// Auth flow: an `onRequest` hook on /mcp extracts the Bearer token, invokes
// the Auth Verifier, and on success attaches the IdentityContext to
// `req.raw.hiveAuth`. After the SDK transport completes the request, we read
// `transport.sessionId` and call `mcpTransport.ensureSessionFor` to bind the
// SessionStore + Presence subscription.

import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import type { Verifier, IdentityContext } from '#domain/auth/index.js';
import { buildJwkSet } from '#domain/auth/index.js';
import type { SigningKey } from '#domain/auth/keys/keypair-store.js';
import type { Logger } from '#observability/logger.js';
import type { Database } from '#persistence/schema.js';

import { verifyBearerHeader } from './auth-binding.js';
import { mapDomainError } from './error-mapper.js';
import type { McpTransport } from './server.js';

export interface HttpHostDeps {
  mcpTransport: McpTransport;
  verifier: Verifier;
  db: Kysely<Database>;
  signingKeysProvider: () => Iterable<SigningKey>;
  logger: Logger;
}

export interface HttpHostOptions {
  /** Default `/mcp`. */
  mcpPath?: string;
  /** Default `0.0.0.0`. */
  host?: string;
  /** Default `8443`. */
  port?: number;
  /** Default 500ms — readyz DB ping timeout. */
  readyzDbTimeoutMs?: number;
}

export interface HttpHost {
  app: FastifyInstance;
  start(): Promise<void>;
  stop(): Promise<void>;
  port(): number | null;
}

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  mcpServer: McpServer;
}

interface HiveAuth {
  identity: IdentityContext;
  requestId: string;
}

export function createHttpHost(deps: HttpHostDeps, options: HttpHostOptions = {}): HttpHost {
  const mcpPath = options.mcpPath ?? '/mcp';
  const host = options.host ?? '0.0.0.0';
  const port = options.port ?? 8443;
  const readyzTimeout = options.readyzDbTimeoutMs ?? 500;

  const app = Fastify({
    logger: false,
    bodyLimit: 4 * 1024 * 1024,
  });

  const sessions = new Map<string, SessionEntry>();

  app.get('/healthz', async (_req, reply) => {
    return reply.code(200).type('application/json').send({ status: 'ok' });
  });

  app.get('/readyz', async (_req, reply) => {
    const result = await pingDb(deps.db, readyzTimeout);
    if (result === 'ok') {
      return reply.code(200).type('application/json').send({ status: 'ready' });
    }
    return reply.code(503).type('application/json').send({ status: 'unready', reason: result });
  });

  app.get('/.well-known/jwks.json', async (_req, reply) => {
    const set = buildJwkSet(deps.signingKeysProvider());
    return reply
      .code(200)
      .type('application/json')
      .header('access-control-allow-origin', '*')
      .send(set);
  });

  // Auth hook for any /mcp request. Verifies the Bearer and attaches HiveAuth.
  app.addHook('onRequest', async (req, reply) => {
    if (req.url !== mcpPath) return;

    const authHeader = req.headers['authorization'] as string | string[] | undefined;
    const headerStr = headerString(authHeader);

    try {
      const auth = await verifyBearerHeader(deps.verifier, headerStr);
      (req.raw as IncomingMessage & { hiveAuth?: HiveAuth }).hiveAuth = auth;
    } catch (err) {
      const mapped = mapDomainError(err);
      deps.logger.warn(
        {
          event: 'mcp_auth_failed',
          domainCode: mapped.domainCode,
          subCode: mapped.subCode,
        },
        mapped.wire.message,
      );
      return reply
        .code(401)
        .type('application/json')
        .send({
          jsonrpc: '2.0',
          error: { code: mapped.wire.code, message: mapped.wire.message },
          id: null,
        });
    }
  });

  app.post(mcpPath, async (req, reply) => {
    const sessionIdHeader = headerString(req.headers['mcp-session-id']);
    const auth = (req.raw as IncomingMessage & { hiveAuth?: HiveAuth }).hiveAuth;
    if (!auth) {
      // The onRequest hook should have rejected this, but defense-in-depth.
      return reply.code(401).send({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'authentication required' },
        id: null,
      });
    }

    // The SDK's StreamableHTTPServerTransport writes directly to res.raw
    // (status, headers, body). fastify must not interfere with the response —
    // hijack tells fastify the handler owns the raw response from here on.
    reply.hijack();

    let entry: SessionEntry;
    let isNewSession = false;

    if (sessionIdHeader !== undefined && sessions.has(sessionIdHeader)) {
      // Existing session — route to its transport.
      entry = sessions.get(sessionIdHeader) as SessionEntry;
    } else {
      // Brand new session: build transport + McpServer + connect.
      const mcpServer = deps.mcpTransport.buildMcpServerForSession();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          sessions.set(sid, { transport, mcpServer });
          deps.mcpTransport.bindSessionServer(sid, mcpServer);
        },
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid !== undefined) {
          sessions.delete(sid);
          deps.mcpTransport.unbindSessionServer(sid);
          deps.mcpTransport.sessionStore.close(sid);
        }
      };
      // The SDK shape declares `onclose: () => void` but accepts undefined at
      // runtime; the strict-optional cast is upstream noise.
      await mcpServer.connect(transport as unknown as Parameters<typeof mcpServer.connect>[0]);
      entry = { transport, mcpServer };
      isNewSession = true;
    }

    await entry.transport.handleRequest(req.raw, reply.raw, req.body);

    // After handleRequest, the transport has either:
    //   (a) on initialize: assigned a sessionId via sessionIdGenerator and
    //       invoked onsessioninitialized (the entry is already in the map).
    //   (b) on subsequent requests: routed against the existing session.
    const sessionId = entry.transport.sessionId;
    if (sessionId !== undefined) {
      try {
        await deps.mcpTransport.ensureSessionFor(sessionId, auth.identity);
      } catch (err) {
        deps.logger.warn(
          {
            event: 'mcp_ensure_session_failed',
            sessionId,
            err: err instanceof Error ? err.message : String(err),
          },
          'ensureSessionFor failed',
        );
      }
    } else if (isNewSession) {
      // SDK rejected the initialize (e.g., bad protocolVersion); session was never registered.
      // The transport already wrote the error response to reply.raw.
      deps.logger.debug(
        { event: 'mcp_initialize_rejected_no_session' },
        'initialize completed without session id',
      );
    }
  });

  // GET /mcp — server-initiated SSE stream.
  app.get(mcpPath, async (req, reply) => {
    const sessionIdHeader = headerString(req.headers['mcp-session-id']);
    if (sessionIdHeader === undefined || !sessions.has(sessionIdHeader)) {
      return reply
        .code(400)
        .type('application/json')
        .send({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: Mcp-Session-Id header is required' },
          id: null,
        });
    }
    const entry = sessions.get(sessionIdHeader) as SessionEntry;
    reply.hijack();
    await entry.transport.handleRequest(req.raw, reply.raw);
  });

  // DELETE /mcp — session termination.
  app.delete(mcpPath, async (req, reply) => {
    const sessionIdHeader = headerString(req.headers['mcp-session-id']);
    if (sessionIdHeader === undefined || !sessions.has(sessionIdHeader)) {
      return reply
        .code(400)
        .type('application/json')
        .send({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: Mcp-Session-Id header is required' },
          id: null,
        });
    }
    const entry = sessions.get(sessionIdHeader) as SessionEntry;
    reply.hijack();
    await entry.transport.handleRequest(req.raw, reply.raw);
  });

  return {
    app,

    async start() {
      await app.listen({ host, port });
    },

    async stop() {
      try {
        deps.mcpTransport.sessionStore.closeAll();
      } catch (err) {
        deps.logger.warn(
          {
            event: 'http_host_close_sessions_failed',
            err: err instanceof Error ? err.message : String(err),
          },
          'closeAll sessions failed',
        );
      }
      // Close all per-session transports.
      const snapshot = Array.from(sessions.values());
      for (const entry of snapshot) {
        try {
          await entry.transport.close();
        } catch {
          /* swallow per-session shutdown errors */
        }
      }
      sessions.clear();

      await app.close();
    },

    port() {
      const address = app.server.address();
      if (typeof address === 'object' && address !== null) return address.port;
      return null;
    },
  };
}

// ---------- helpers ----------

function headerString(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

type DbPingResult = 'ok' | 'db_timeout' | 'db_error';

async function pingDb(db: Kysely<Database>, timeoutMs: number): Promise<DbPingResult> {
  const ping = sql<{ one: number }>`select 1 as one`.execute(db).then(() => 'ok' as const);
  const timeout = new Promise<DbPingResult>((resolve) => {
    setTimeout(() => resolve('db_timeout'), timeoutMs);
  });
  try {
    const result = await Promise.race([ping, timeout]);
    return result;
  } catch {
    return 'db_error';
  }
}
