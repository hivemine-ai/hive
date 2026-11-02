// Edge behaviour of the HTTP host, on top of stubbed domain ports: what happens before
// the SDK sees a request, and which error codes survive the SDK encoding on the wire.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthError } from '#domain/auth/index.js';
import type { IdentityContext, ParticipantsReadRepo, Verifier } from '#domain/auth/index.js';
import { CellError } from '#domain/cells/index.js';
import type { CellsRepo, Reader, Sender } from '#domain/cells/index.js';
import type { PresenceRegistry } from '#domain/notifications/index.js';
import type { VisibilityEngine } from '#domain/visibility/index.js';
import { createLogger } from '#observability/logger.js';

import type { LastConnectedRefresher } from './auth-binding.js';
import {
  createHttpHost,
  type HttpHost,
  type HttpHostOptions,
  type ListenEdge,
} from './http-host.js';
import { createMcpTransport } from './server.js';

const VERSION = '2026-07-28';
const PARTICIPANT_ID = '01900000-0000-7000-8000-000000000001';

const IDENTITY = {
  participantId: PARTICIPANT_ID,
  kind: 'worker',
  hiveId: '01900000-0000-7000-8000-000000000002',
  hiveName: 'test-hive',
  colonyId: '01900000-0000-7000-8000-000000000003',
} as unknown as IdentityContext;

interface StubOptions {
  verify?: Verifier['verify'];
  sender?: Partial<Sender>;
  reader?: Partial<Reader>;
  listenEdge?: ListenEdge;
  lastConnected?: LastConnectedRefresher;
  host?: HttpHostOptions;
}

let current: HttpHost | undefined;

async function startHost(options: StubOptions = {}): Promise<string> {
  const logger = createLogger({ level: 'silent' });
  const mcpTransport = createMcpTransport({
    participantsRepo: {
      getParticipantState: () => Promise.resolve({ state: 'active' }),
    } as unknown as ParticipantsReadRepo,
    cellsRepo: {} as CellsRepo,
    sender: (options.sender ?? {}) as Sender,
    reader: (options.reader ?? {}) as Reader,
    visibilityEngine: {} as VisibilityEngine,
    presenceRegistry: {} as PresenceRegistry,
    logger,
    listAgentsMaxPageSize: 100,
  });
  current = createHttpHost(
    {
      mcpTransport,
      verifier: { verify: options.verify ?? (() => Promise.resolve(IDENTITY)) },
      lastConnected: options.lastConnected ?? { refresh: () => undefined },
      db: {} as never,
      signingKeysProvider: () => [],
      logger,
      ...(options.listenEdge && { listenEdge: options.listenEdge }),
    },
    { host: '127.0.0.1', port: 0, ...options.host },
  );
  await current.start();
  return `http://127.0.0.1:${String(current.port())}/mcp`;
}

afterEach(async () => {
  await current?.stop();
  current = undefined;
});

function post(
  url: string,
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<Response> {
  const name = params['name'];
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer token',
      'mcp-protocol-version': VERSION,
      'mcp-method': method,
      ...(typeof name === 'string' && { 'mcp-name': name }),
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': VERSION,
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
}

function listenInit(): RequestInit {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer token',
      'mcp-protocol-version': VERSION,
      'mcp-method': 'subscriptions/listen',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'subscriptions/listen',
      params: {
        notifications: { toolsListChanged: true },
        _meta: {
          'io.modelcontextprotocol/protocolVersion': VERSION,
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  };
}

function callTool(url: string, name: string, args: Record<string, unknown>): Promise<Response> {
  return post(url, 'tools/call', { name, arguments: args });
}

interface RpcError {
  error: { code: number; message: string; data?: unknown };
}

describe('auth at the edge', () => {
  it('answers an auth failure with 401 and -32001', async () => {
    const url = await startHost({
      verify: () => Promise.reject(new AuthError('CREDENTIAL_REVOKED')),
    });

    const res = await post(url, 'tools/list');

    expect(res.status).toBe(401);
    expect(((await res.json()) as RpcError).error.code).toBe(-32001);
  });

  it('answers a database failure in verify with -32603, never -32001', async () => {
    const url = await startHost({
      verify: () => Promise.reject(new Error('database is locked')),
    });

    const res = await post(url, 'tools/list');

    expect(res.status).toBe(500);
    const body = (await res.json()) as RpcError;
    expect(body.error).toEqual({ code: -32603, message: 'internal error' });
  });

  it('refreshes last_connected_at on any authenticated request', async () => {
    const refresh = vi.fn();
    const url = await startHost({ lastConnected: { refresh } });

    await post(url, 'tools/list');

    expect(refresh).toHaveBeenCalledWith(IDENTITY);
  });

  it('does not refresh last_connected_at when authentication fails', async () => {
    const refresh = vi.fn();
    const url = await startHost({
      lastConnected: { refresh },
      verify: () => Promise.reject(new AuthError('CREDENTIAL_EXPIRED')),
    });

    await post(url, 'tools/list');

    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('Origin and Host', () => {
  it('lets through a request without Origin', async () => {
    const url = await startHost();

    expect((await post(url, 'tools/list')).status).toBe(200);
  });

  it('rejects an Origin outside the allowlist with 403, before verifying the Bearer', async () => {
    const verify = vi.fn(() => Promise.resolve(IDENTITY));
    const url = await startHost({
      verify,
      host: { allowedOrigins: ['https://app.example'] },
    });

    const res = await post(url, 'tools/list', {}, { origin: 'https://evil.example' });

    expect(res.status).toBe(403);
    expect(await res.text()).toBe('');
    expect(verify).not.toHaveBeenCalled();
  });

  it('rejects any Origin when the allowlist is empty', async () => {
    const url = await startHost();

    const res = await post(url, 'tools/list', {}, { origin: 'https://app.example' });

    expect(res.status).toBe(403);
  });

  it('accepts an Origin in the allowlist', async () => {
    const url = await startHost({ host: { allowedOrigins: ['https://app.example'] } });

    const res = await post(url, 'tools/list', {}, { origin: 'https://app.example' });

    expect(res.status).toBe(200);
  });

  it('rejects a Host outside the allowlist with 403 when one is configured', async () => {
    const url = await startHost({ host: { allowedHosts: ['hive.example:8443'] } });

    expect((await post(url, 'tools/list')).status).toBe(403);
  });
});

describe('error codes on the wire', () => {
  it('INSUFFICIENT_PRIVILEGE survives the SDK encoding, unlike the retired -32002', async () => {
    const url = await startHost({
      reader: {
        readMailbox: () => Promise.reject(new CellError('INSUFFICIENT_PRIVILEGE')),
      },
    });

    const res = await callTool(url, 'read_mailbox', {});

    expect(((await res.json()) as RpcError).error).toEqual({ code: -32006, message: 'forbidden' });
  });

  it('send_message at the quota answers -32005 with limit and current', async () => {
    const url = await startHost({
      sender: {
        sendMessage: () =>
          Promise.reject(
            new CellError('SENDER_QUOTA_EXCEEDED', {
              subCode: 'pair_unread_cap',
              data: { limit: 500, current: 500 },
            }),
          ),
      },
    });

    const res = await callTool(url, 'send_message', {
      recipient: PARTICIPANT_ID,
      type: 'notification',
      body: 'hello',
    });

    expect(((await res.json()) as RpcError).error).toEqual({
      code: -32005,
      message: 'sender quota exceeded',
      data: { limit: 500, current: 500 },
    });
  });

  it('an unknown tool is an invalid param', async () => {
    const url = await startHost();

    const res = await callTool(url, 'nope', {});

    expect(((await res.json()) as RpcError).error.code).toBe(-32602);
  });
});

describe('listen edge', () => {
  const listen = (url: string) =>
    post(url, 'subscriptions/listen', {
      notifications: { resourceSubscriptions: ['hive://cells/foreign'] },
    });

  it('refuses a stream before the SDK when the edge says so', async () => {
    const onResponse = vi.fn();
    const url = await startHost({
      listenEdge: {
        authorize: () => ({ code: -32602, message: 'invalid input' }),
        onResponse,
      },
    });

    const res = await listen(url);

    expect(((await res.json()) as RpcError).error.code).toBe(-32602);
    expect(onResponse).not.toHaveBeenCalled();
  });

  it('hands the SDK stream to the edge before any byte reaches the client', async () => {
    const onResponse = vi.fn();
    const url = await startHost({ listenEdge: { authorize: () => null, onResponse } });

    const abort = new AbortController();
    const res = await fetch(url, {
      ...listenInit(),
      signal: abort.signal,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(onResponse).toHaveBeenCalledTimes(1);
    expect(onResponse.mock.calls[0]?.[0]).toMatchObject({ identity: IDENTITY });
    abort.abort();
  });

  it('is not consulted for any other method', async () => {
    const authorize = vi.fn(() => null);
    const url = await startHost({ listenEdge: { authorize, onResponse: () => undefined } });

    await post(url, 'tools/list');

    expect(authorize).not.toHaveBeenCalled();
  });
});
