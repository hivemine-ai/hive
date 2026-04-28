import { Writable } from 'node:stream';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from './logger.js';
import { attachRequestIdHook } from './request-id.js';

const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type CaptureLogger = ReturnType<typeof createLogger>;

/** Builds a logger + capture stream for asserting emitted log lines. */
function buildCaptureLogger(): {
  logger: CaptureLogger;
  getLines: () => Record<string, unknown>[];
} {
  const rawLines: string[] = [];
  const dest = new Writable({
    write(chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
      rawLines.push(chunk.toString());
      cb();
    },
  });
  const logger = createLogger({ level: 'info', pretty: false }, dest);
  return {
    logger,
    getLines: () =>
      rawLines
        .flatMap((raw) => raw.split('\n').filter((l) => l.trim() !== ''))
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

describe('attachRequestIdHook', () => {
  let fastify: FastifyInstance;
  let logger: CaptureLogger;
  let getLines: () => Record<string, unknown>[];

  beforeEach(() => {
    fastify = Fastify({ logger: false });
    ({ logger, getLines } = buildCaptureLogger());
  });

  afterEach(async () => {
    await fastify.close();
  });

  it('generates a UUIDv7 requestId when no inbound header is set', async () => {
    attachRequestIdHook(fastify, logger);
    fastify.get('/test', (_req, reply) => reply.send({ ok: true }));
    await fastify.inject({ method: 'GET', url: '/test' });

    const lines = getLines();
    const completed = lines.find((l) => l['event'] === 'http_request_completed');
    expect(completed).toBeDefined();
    expect(typeof completed!['requestId']).toBe('string');
    expect(UUIDV7_RE.test(completed!['requestId'] as string)).toBe(true);
  });

  it('respects a valid UUIDv7 from the inbound x-request-id header', async () => {
    const inboundId = uuidv7();
    attachRequestIdHook(fastify, logger);
    fastify.get('/test', (_req, reply) => reply.send({ ok: true }));
    await fastify.inject({ method: 'GET', url: '/test', headers: { 'x-request-id': inboundId } });

    const lines = getLines();
    const completed = lines.find((l) => l['event'] === 'http_request_completed');
    expect(completed).toBeDefined();
    expect(completed!['requestId']).toBe(inboundId);
  });

  it('discards an invalid header value and generates a fresh UUIDv7', async () => {
    attachRequestIdHook(fastify, logger);
    fastify.get('/test', (_req, reply) => reply.send({ ok: true }));
    await fastify.inject({
      method: 'GET',
      url: '/test',
      headers: { 'x-request-id': 'not-a-uuid' },
    });

    const lines = getLines();
    const completed = lines.find((l) => l['event'] === 'http_request_completed');
    expect(completed).toBeDefined();
    const requestId = completed!['requestId'] as string;
    expect(UUIDV7_RE.test(requestId)).toBe(true);
    expect(requestId).not.toBe('not-a-uuid');
  });

  it('respects custom header name from opts.headerName', async () => {
    const inboundId = uuidv7();
    attachRequestIdHook(fastify, logger, { headerName: 'x-correlation-id' });
    fastify.get('/test', (_req, reply) => reply.send({ ok: true }));
    await fastify.inject({
      method: 'GET',
      url: '/test',
      headers: { 'x-correlation-id': inboundId },
    });

    const lines = getLines();
    const completed = lines.find((l) => l['event'] === 'http_request_completed');
    expect(completed).toBeDefined();
    expect(completed!['requestId']).toBe(inboundId);
  });

  it('respects HIVE_OBSERVABILITY_REQUEST_ID_HEADER env var', async () => {
    const inboundId = uuidv7();
    const original = process.env['HIVE_OBSERVABILITY_REQUEST_ID_HEADER'];
    process.env['HIVE_OBSERVABILITY_REQUEST_ID_HEADER'] = 'x-trace-id';
    try {
      attachRequestIdHook(fastify, logger);
      fastify.get('/test', (_req, reply) => reply.send({ ok: true }));
      await fastify.inject({ method: 'GET', url: '/test', headers: { 'x-trace-id': inboundId } });

      const lines = getLines();
      const completed = lines.find((l) => l['event'] === 'http_request_completed');
      expect(completed).toBeDefined();
      expect(completed!['requestId']).toBe(inboundId);
    } finally {
      if (original === undefined) {
        delete process.env['HIVE_OBSERVABILITY_REQUEST_ID_HEADER'];
      } else {
        process.env['HIVE_OBSERVABILITY_REQUEST_ID_HEADER'] = original;
      }
    }
  });

  it('emits http_request_completed at info level with required fields', async () => {
    attachRequestIdHook(fastify, logger);
    fastify.get('/test', (_req, reply) => reply.send({ ok: true }));
    await fastify.inject({ method: 'GET', url: '/test' });

    const lines = getLines();
    const completed = lines.find((l) => l['event'] === 'http_request_completed');
    expect(completed).toBeDefined();
    expect(completed!['level']).toBe(30);
    expect(completed!['event']).toBe('http_request_completed');
    expect(completed!['method']).toBe('GET');
    expect(completed!['path']).toBe('/test');
    expect(completed!['statusCode']).toBe(200);
    expect(typeof completed!['durationMs']).toBe('number');
    expect(completed!['durationMs'] as number).toBeGreaterThanOrEqual(0);
    expect(completed!['participantId']).toBeUndefined();
  });

  it('includes participantId when request.identity is decorated by another hook', async () => {
    const participantId = uuidv7();
    attachRequestIdHook(fastify, logger);
    fastify.addHook('onRequest', (req: FastifyRequest, _reply: FastifyReply, done: () => void) => {
      (req as unknown as Record<string, unknown>)['identity'] = { participantId };
      done();
    });
    fastify.get('/test', (_req, reply) => reply.send({ ok: true }));
    await fastify.inject({ method: 'GET', url: '/test' });

    const lines = getLines();
    const completed = lines.find((l) => l['event'] === 'http_request_completed');
    expect(completed).toBeDefined();
    expect(completed!['participantId']).toBe(participantId);
  });

  it('emits http_request_completed even when the handler throws', async () => {
    attachRequestIdHook(fastify, logger);
    fastify.get('/boom', () => {
      throw new Error('handler error');
    });
    const response = await fastify.inject({ method: 'GET', url: '/boom' });

    expect(response.statusCode).toBe(500);

    const lines = getLines();
    const completed = lines.find((l) => l['event'] === 'http_request_completed');
    expect(completed).toBeDefined();
    expect(completed!['statusCode']).toBe(500);
    expect(UUIDV7_RE.test(completed!['requestId'] as string)).toBe(true);
  });

  it('decorates request.log with requestId binding for handler use', async () => {
    attachRequestIdHook(fastify, logger);
    fastify.get('/test', (req: FastifyRequest, reply: FastifyReply) => {
      req.log.info({ event: 'handler_ran' }, 'handler ran');
      return reply.send({ ok: true });
    });
    await fastify.inject({ method: 'GET', url: '/test' });

    const lines = getLines();
    const handlerLine = lines.find((l) => l['event'] === 'handler_ran');
    const completedLine = lines.find((l) => l['event'] === 'http_request_completed');

    expect(handlerLine).toBeDefined();
    expect(completedLine).toBeDefined();

    const handlerRequestId = handlerLine!['requestId'] as string;
    const completedRequestId = completedLine!['requestId'] as string;

    expect(UUIDV7_RE.test(handlerRequestId)).toBe(true);
    expect(handlerRequestId).toBe(completedRequestId);
  });
});
