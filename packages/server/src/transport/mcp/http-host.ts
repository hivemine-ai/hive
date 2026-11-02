// fastify HTTP host for the MCP transport, on revision 2026-07-28 only:
//   - POST /mcp        → the only MCP method. Edge in front of the SDK handler
//   - GET, DELETE /mcp → 405, the revision removed both
//   - GET  /healthz    → 200 always (liveness)
//   - GET  /readyz     → 200 if DB ping succeeds within timeout, else 503
//   - GET  /.well-known/jwks.json → public JWKS from KeypairStore
//
// `createMcpHandler` builds one server instance per request, so this file holds no
// per-client state. For each POST the edge validates Origin and Host, verifies the
// Bearer, and passes the identity to the SDK as authInfo along with the body fastify
// already parsed. `legacy: 'reject'` matters: the SDK default keeps serving 2025-era
// traffic, and Hive keeps no legacy support.

import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { createMcpHandler } from '@modelcontextprotocol/server';
import { HIVE_DEFAULT_HTTP_PORT } from '@hive/shared';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';

import { buildJwkSet, isAuthError } from '#domain/auth/index.js';
import type { IdentityContext, UUIDv7, Verifier } from '#domain/auth/index.js';
import type { SigningKey } from '#domain/auth/keys/keypair-store.js';
import { getRequestIdFromLogger, type Logger } from '#observability/logger.js';
import { attachRequestIdHook } from '#observability/request-id.js';
import type { Database } from '#persistence/schema.js';

import { toAuthInfo, verifyBearerHeader, type LastConnectedRefresher } from './auth-binding.js';
import { mapDomainError } from './error-mapper.js';
import { isAllowedByOriginGuard } from './origin-guard.js';
import type { McpTransport } from './server.js';
import type { WireError } from './types.js';

const LISTEN_METHOD = 'subscriptions/listen';

/**
 * Plug-in point for the `subscriptions/listen` edge. The SDK router neither checks who
 * owns a URI nor exposes stream open and close, so the edge wraps the handler instead.
 */
export interface ListenEdge {
  /** Runs before the SDK. A returned error refuses the stream. */
  authorize(input: { body: unknown; identity: IdentityContext }): WireError | null;
  /** Runs once the SDK answered, before any byte reaches the client. */
  onResponse(input: {
    body: unknown;
    identity: IdentityContext;
    requestId: UUIDv7;
    response: Response;
    raw: ServerResponse;
  }): void;
}

export interface HttpHostDeps {
  mcpTransport: McpTransport;
  verifier: Verifier;
  lastConnected: LastConnectedRefresher;
  db: Kysely<Database>;
  signingKeysProvider: () => Iterable<SigningKey>;
  logger: Logger;
  listenEdge?: ListenEdge;
}

export interface HttpHostOptions {
  /** Default `/mcp`. */
  mcpPath?: string;
  /** Default `0.0.0.0`. */
  host?: string;
  /** Default {@link HIVE_DEFAULT_HTTP_PORT} (`8443`). */
  port?: number;
  /** Default 500ms — readyz DB ping timeout. */
  readyzDbTimeoutMs?: number;
  /** Default empty: a request carrying `Origin` is rejected. */
  allowedOrigins?: readonly string[];
  /** Default empty: `Host` is not validated. */
  allowedHosts?: readonly string[];
}

export interface HttpHost {
  app: FastifyInstance;
  start(): Promise<void>;
  stop(): Promise<void>;
  port(): number | null;
}

export function createHttpHost(deps: HttpHostDeps, options: HttpHostOptions = {}): HttpHost {
  const mcpPath = options.mcpPath ?? '/mcp';
  const host = options.host ?? '0.0.0.0';
  const port = options.port ?? HIVE_DEFAULT_HTTP_PORT;
  const readyzTimeout = options.readyzDbTimeoutMs ?? 500;
  const originGuard = {
    allowedOrigins: options.allowedOrigins ?? [],
    allowedHosts: options.allowedHosts ?? [],
  };

  const mcpHandler = createMcpHandler(() => deps.mcpTransport.buildServer(), {
    legacy: 'reject',
    onerror: (err) => {
      deps.logger.debug({ event: 'mcp_sdk_error', err: err.message }, 'mcp sdk error');
    },
  });

  const app = Fastify({
    logger: false,
    bodyLimit: 4 * 1024 * 1024,
  });

  // Request-id hook MUST be attached before any routes or auth hooks so every
  // request inherits the `requestId`-bound child logger from the start. The
  // auth hook below logs `mcp_auth_failed` via the request-scoped logger when
  // available, and the audit recorder downstream reads `requestId` from the
  // logger context to populate `audit_log.request_id`.
  attachRequestIdHook(app, deps.logger);

  const identities = new WeakMap<FastifyRequest, IdentityContext>();

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

  // Edge for POST to the MCP path, in spec order: Origin and Host, then the Bearer.
  app.addHook('onRequest', async (req, reply) => {
    if (req.method !== 'POST' || req.routeOptions.url !== mcpPath) return;

    const allowed = isAllowedByOriginGuard(originGuard, {
      origin: headerString(req.headers.origin),
      host: headerString(req.headers.host),
    });
    if (!allowed) {
      deps.logger.warn({ event: 'mcp_origin_rejected' }, 'origin or host not allowed');
      return reply.code(403).send();
    }

    try {
      const auth = await verifyBearerHeader(deps.verifier, headerString(req.headers.authorization));
      identities.set(req, auth.identity);
      deps.lastConnected.refresh(auth.identity);
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
      // Only a real auth verdict is a 401. An infrastructure failure must not tell
      // a client with a valid credential that its credential is bad.
      return reply
        .code(isAuthError(err) ? 401 : 500)
        .type('application/json')
        .send({ jsonrpc: '2.0', error: mapped.wire, id: null });
    }
  });

  app.post(mcpPath, async (req, reply) => {
    const identity = identities.get(req);
    if (!identity) {
      // The onRequest hook should have rejected this, but defense-in-depth.
      return reply.code(401).send({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'authentication required' },
        id: null,
      });
    }

    const body = req.body;
    const isListen = rpcMethod(body) === LISTEN_METHOD;
    if (isListen && deps.listenEdge) {
      const refusal = deps.listenEdge.authorize({ body, identity });
      if (refusal) {
        return reply
          .code(200)
          .type('application/json')
          .send({ jsonrpc: '2.0', error: refusal, id: rpcId(body) });
      }
    }

    const requestId = getRequestIdFromLogger(req.log as Logger) ?? uuidv7();
    const abort = new AbortController();
    const response = await mcpHandler.fetch(toWebRequest(req, mcpPath, abort.signal), {
      authInfo: toAuthInfo({ identity, requestId }),
      parsedBody: body,
    });

    // The body may be a long stream, so the handler owns the raw response from here on.
    reply.hijack();
    const raw = reply.raw;
    raw.on('close', () => abort.abort());
    if (isListen) deps.listenEdge?.onResponse({ body, identity, requestId, response, raw });

    raw.writeHead(response.status, Object.fromEntries(response.headers));
    if (!response.body) {
      raw.end();
      return;
    }
    Readable.fromWeb(response.body)
      .on('error', () => raw.destroy())
      .pipe(raw);
  });

  // The revision removed the GET stream and session termination.
  app.route({
    method: ['GET', 'DELETE'],
    url: mcpPath,
    handler: async (_req, reply) => {
      return reply.code(405).header('allow', 'POST').send();
    },
  });

  return {
    app,

    async start() {
      await app.listen({ host, port });
    },

    async stop() {
      await mcpHandler.close();
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

function toWebRequest(req: FastifyRequest, mcpPath: string, signal: AbortSignal): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  // Fixed origin: the client-controlled Host header must not reach URL parsing. The SDK
  // routes on the body and the headers, never on this URL.
  return new Request(`http://hive.invalid${mcpPath}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(req.body),
    signal,
  });
}

function rpcMethod(body: unknown): unknown {
  return (body as { method?: unknown } | null | undefined)?.method;
}

function rpcId(body: unknown): string | number | null {
  const id = (body as { id?: unknown } | null | undefined)?.id;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

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
