import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { v7 as uuidv7, validate as uuidValidate, version as uuidVersion } from 'uuid';

import type { Logger } from '#observability/logger.js';

export interface RequestIdHookOptions {
  /**
   * Header name to read if present. If the client sends a requestId, it is
   * respected (useful for cross-system correlation). If the value is not a
   * valid UUIDv7, it is discarded and a fresh one is generated.
   *
   * Precedence: opts.headerName > process.env.HIVE_OBSERVABILITY_REQUEST_ID_HEADER
   *              > 'x-request-id' (default).
   */
  headerName?: string;
}

interface RequestWithExtras extends FastifyRequest {
  startTimeMs?: number;
  identity?: { participantId?: string };
}

function isUuidV7(value: string): boolean {
  return uuidValidate(value) && uuidVersion(value) === 7;
}

function readOrGenerate(headers: FastifyRequest['headers'], headerName: string): string {
  const raw = headers[headerName];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value === 'string' && isUuidV7(value)) {
    return value;
  }
  return uuidv7();
}

function getRequestLog(req: FastifyRequest, fallback: Logger): Logger {
  const log = (req as RequestWithExtras & { log: Logger }).log;
  return log ?? fallback;
}

export function attachRequestIdHook(
  fastify: FastifyInstance,
  logger: Logger,
  opts?: RequestIdHookOptions,
): void {
  const headerName = (
    opts?.headerName ??
    process.env['HIVE_OBSERVABILITY_REQUEST_ID_HEADER'] ??
    'x-request-id'
  ).toLowerCase();

  fastify.decorateRequest('startTimeMs', null);

  fastify.addHook('onRequest', (req: FastifyRequest, _reply: FastifyReply, done: () => void) => {
    const requestId = readOrGenerate(req.headers, headerName);
    const requestLog = logger.child({ requestId });
    // Override req.log so all downstream handlers carry the requestId binding.
    (req as RequestWithExtras & { log: Logger }).log = requestLog;
    (req as RequestWithExtras).startTimeMs = Date.now();
    // Write the canonical requestId back to req.headers so transports that
    // forward headers downstream (eg. the MCP SDK's StreamableHTTPServerTransport
    // → extra.requestInfo.headers in setRequestHandler) can recover it without
    // touching fastify internals or AsyncLocalStorage. Headers are normalised
    // to lowercase by Node's http parser.
    req.headers[headerName] = requestId;
    done();
  });

  fastify.addHook('onResponse', (req: FastifyRequest, reply: FastifyReply, done: () => void) => {
    const startTimeMs = (req as RequestWithExtras).startTimeMs ?? Date.now();
    const durationMs = Date.now() - startTimeMs;
    const requestLog = getRequestLog(req, logger);
    const bindings = requestLog.bindings();
    const requestId: unknown = bindings['requestId'];

    const fields: Record<string, unknown> = {
      event: 'http_request_completed',
      requestId,
      method: req.method,
      path: req.routeOptions.url ?? req.url,
      statusCode: reply.statusCode,
      durationMs,
    };

    const identity = (req as RequestWithExtras).identity;
    if (identity?.participantId !== undefined) {
      fields['participantId'] = identity.participantId;
    }

    requestLog.info(fields, 'http request completed');
    done();
  });
}
