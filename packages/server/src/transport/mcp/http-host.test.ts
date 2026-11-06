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
import type { Logger } from '#observability/logger.js';

import type { LastConnectedRefresher } from './auth-binding.js';
import { createRegisterRateLimiter, type RegisterRateLimiter } from './enrollment-guards.js';
import {
  createHttpHost,
  type HttpHost,
  type HttpHostOptions,
  type ListenEdge,
} from './http-host.js';
import { createMcpTransport, type McpTransportDeps } from './server.js';

const VERSION = '2026-07-28';
const PARTICIPANT_ID = '01900000-0000-7000-8000-000000000001';

const IDENTITY = {
  participantId: PARTICIPANT_ID,
  kind: 'worker',
  hiveId: '01900000-0000-7000-8000-000000000002',
  hiveName: 'test-hive',
  colonyId: '01900000-0000-7000-8000-000000000003',
  snapshot: {
    issuedAt: new Date(),
    credentialJti: '01900000-0000-7000-8000-000000000008',
    credentialKid: 'kid',
  },
} as unknown as IdentityContext;

interface StubOptions {
  verify?: Verifier['verify'];
  verifyRenewalBearer?: Verifier['verifyRenewalBearer'];
  sender?: Partial<Sender>;
  reader?: Partial<Reader>;
  listenEdge?: ListenEdge;
  lastConnected?: LastConnectedRefresher;
  host?: HttpHostOptions;
  logger?: Logger;
  cellsRepo?: Partial<CellsRepo>;
  registerRateLimiter?: RegisterRateLimiter;
}

let current: HttpHost | undefined;

async function startHost(options: StubOptions = {}): Promise<string> {
  const logger = options.logger ?? createLogger({ level: 'silent' });
  const mcpTransport = createMcpTransport({
    participantsRepo: {
      getParticipantState: () => Promise.resolve({ state: 'active' }),
    } as unknown as ParticipantsReadRepo,
    cellsRepo: (options.cellsRepo ?? {}) as CellsRepo,
    sender: (options.sender ?? {}) as Sender,
    reader: (options.reader ?? {}) as Reader,
    visibilityEngine: {} as VisibilityEngine,
    presenceRegistry: {} as PresenceRegistry,
    logger,
    listAgentsMaxPageSize: 100,
    enrollment: {} as McpTransportDeps['enrollment'],
    rebindParticipantStreams: () => 0,
    rejectAlerts: { record: () => ({ alert: false }) },
    rejectAlertWindowMinutes: 10,
    auditRecorder: { recordEvent: () => Promise.resolve() },
  });
  current = createHttpHost(
    {
      mcpTransport,
      verifier: {
        verify: options.verify ?? (() => Promise.resolve(IDENTITY)),
        verifyRenewalBearer:
          options.verifyRenewalBearer ??
          (() => Promise.reject(new AuthError('CREDENTIAL_EXPIRED'))),
      },
      lastConnected: options.lastConnected ?? { refresh: () => undefined },
      db: {} as never,
      signingKeysProvider: () => [],
      logger,
      ...(options.listenEdge && { listenEdge: options.listenEdge }),
      ...(options.registerRateLimiter && { registerRateLimiter: options.registerRateLimiter }),
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

// ADR-026 (PRY-091): an enrollment credential reaches only register_session and
// server/discover; everything else is an authentic credential out of its scope.
describe('scoped credentials at the edge', () => {
  const ENROLLMENT_IDENTITY = {
    ...IDENTITY,
    kind: 'hivekeeper',
    snapshot: {
      issuedAt: new Date(),
      credentialJti: '01900000-0000-7000-8000-000000000009',
      credentialKid: 'kid',
      scope: 'enroll',
    },
    current: { state: 'active' },
  } as unknown as IdentityContext;

  it('rejects an enrollment credential calling list_agents with 403 and -32006', async () => {
    const refresh = vi.fn();
    const warn = vi.fn();
    const logger = createLogger({ level: 'silent' });
    logger.warn = warn;
    const url = await startHost({
      verify: () => Promise.resolve(ENROLLMENT_IDENTITY),
      lastConnected: { refresh },
      logger,
    });

    const res = await callTool(url, 'list_agents', {});

    expect(res.status).toBe(403);
    expect(((await res.json()) as RpcError).error).toEqual({
      code: -32006,
      message: 'credential out of scope',
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'mcp_auth_failed',
        domainCode: 'INSUFFICIENT_PRIVILEGE',
        subCode: 'scoped_credential',
        operation: 'tools_call:list_agents',
      }),
      expect.any(String),
    );
  });

  it('rejects it on tools/list, resources/* and subscriptions/listen', async () => {
    const url = await startHost({ verify: () => Promise.resolve(ENROLLMENT_IDENTITY) });
    for (const method of ['tools/list', 'resources/list', 'resources/read']) {
      const res = await post(url, method);
      expect(res.status).toBe(403);
      expect(((await res.json()) as RpcError).error.code).toBe(-32006);
    }
    const listen = await fetch(url, listenInit());
    expect(listen.status).toBe(403);
  });

  it('lets it through on server/discover and register_session', async () => {
    const refresh = vi.fn();
    const url = await startHost({
      verify: () => Promise.resolve(ENROLLMENT_IDENTITY),
      lastConnected: { refresh },
    });

    expect((await post(url, 'server/discover')).status).toBe(200);
    const register = await callTool(url, 'register_session', {});
    expect(register.status).not.toBe(403);
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('register_session rate limit at the edge', () => {
  const ENROLLMENT = {
    ...IDENTITY,
    kind: 'hivekeeper',
    snapshot: { ...IDENTITY.snapshot, scope: 'enroll' },
  } as unknown as IdentityContext;

  it('answers 429 with Retry-After and -32011 once the key spent its window, logging no jti', async () => {
    const warn = vi.fn();
    const logger = createLogger({ level: 'silent' });
    logger.warn = warn;
    const url = await startHost({
      verify: () => Promise.resolve(ENROLLMENT),
      registerRateLimiter: createRegisterRateLimiter({ limit: 1, windowSeconds: 60 }),
      logger,
    });

    const first = await callTool(url, 'register_session', {});
    const second = await callTool(url, 'register_session', {});

    expect(first.status).not.toBe(429);
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toBe('60');
    expect(((await second.json()) as RpcError).error).toEqual({
      code: -32011,
      message: 'too many registrations',
    });
    expect(warn).toHaveBeenCalledWith(
      { event: 'mcp_enrollment_rate_limited', keyKind: 'enrollment_jti', retryAfterSeconds: 60 },
      expect.any(String),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(IDENTITY.snapshot.credentialJti);
  });

  it('keys a renewal by the Agent id and leaves other tools alone', async () => {
    const hit = vi.fn(() => ({ allowed: true as const }));
    const renewal = {
      ...IDENTITY,
      snapshot: { ...IDENTITY.snapshot, renewal: true },
    } as unknown as IdentityContext;
    const url = await startHost({
      verifyRenewalBearer: () => Promise.resolve(renewal),
      registerRateLimiter: { hit },
    });
    const bearer = `Bearer ${Buffer.from('{"alg":"EdDSA"}').toString('base64url')}.${Buffer.from(
      '{"sub":"agent"}',
    ).toString('base64url')}.c2ln`;

    await post(
      url,
      'tools/call',
      { name: 'register_session', arguments: {} },
      { authorization: bearer },
    );
    await callTool(url, 'list_agents', {});

    expect(hit.mock.calls).toEqual([[`agent_id:${PARTICIPANT_ID}`]]);
  });

  it('marks the register_session response as not cacheable', async () => {
    const url = await startHost({ verify: () => Promise.resolve(ENROLLMENT) });

    const res = await callTool(url, 'register_session', {});

    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('renewal route of register_session', () => {
  const WORKER_BEARER = `Bearer ${Buffer.from('{"alg":"EdDSA"}').toString('base64url')}.${Buffer.from(
    '{"sub":"agent","kind":"worker"}',
  ).toString('base64url')}.c2ln`;

  it('verifies an unscoped Bearer on register_session with verifyRenewalBearer', async () => {
    const verify = vi.fn(() => Promise.reject(new AuthError('CREDENTIAL_EXPIRED')));
    const verifyRenewalBearer = vi.fn(() =>
      Promise.reject(new AuthError('CREDENTIAL_INAUTHENTIC', { subCode: 'holder_proof_expired' })),
    );
    const url = await startHost({ verify, verifyRenewalBearer });

    const res = await post(
      url,
      'tools/call',
      { name: 'register_session', arguments: {} },
      { authorization: WORKER_BEARER },
    );

    expect(res.status).toBe(401);
    expect(((await res.json()) as RpcError).error.code).toBe(-32001);
    expect(verifyRenewalBearer).toHaveBeenCalledWith(WORKER_BEARER);
    expect(verify).not.toHaveBeenCalled();
  });

  it('never routes another tool through the renewal variant', async () => {
    const verifyRenewalBearer = vi.fn(() => Promise.resolve(IDENTITY));
    const url = await startHost({
      verify: () => Promise.reject(new AuthError('CREDENTIAL_EXPIRED')),
      verifyRenewalBearer,
    });

    const res = await post(
      url,
      'tools/call',
      { name: 'send_message', arguments: {} },
      { authorization: WORKER_BEARER },
    );

    expect(res.status).toBe(401);
    expect(verifyRenewalBearer).not.toHaveBeenCalled();
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

describe('resources for a caller without a Cell', () => {
  const noCell = { findCellByOwner: () => Promise.resolve(null) };

  it('resources/list answers an empty list', async () => {
    const url = await startHost({ cellsRepo: noCell });
    const res = await post(url, 'resources/list');
    expect(((await res.json()) as { result: { resources: unknown[] } }).result.resources).toEqual(
      [],
    );
  });

  it('resources/read answers the same -32602 as a foreign URI', async () => {
    const url = await startHost({ cellsRepo: noCell });
    const uri = 'hive://cells/any';
    const res = await post(url, 'resources/read', { uri }, { 'mcp-name': uri });
    expect(((await res.json()) as RpcError).error).toMatchObject({
      code: -32602,
      message: 'invalid input',
    });
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
        renewLease: () => false,
      },
    });

    const res = await listen(url);

    expect(((await res.json()) as RpcError).error.code).toBe(-32602);
    expect(onResponse).not.toHaveBeenCalled();
  });

  it('hands the SDK stream to the edge before any byte reaches the client', async () => {
    const onResponse = vi.fn();
    const url = await startHost({
      listenEdge: { authorize: () => null, onResponse, renewLease: () => false },
    });

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

  it('tells the edge once the acknowledgment reached the response', async () => {
    const onAcknowledged = vi.fn();
    const url = await startHost({
      listenEdge: {
        authorize: () => null,
        onResponse: () => ({ onAcknowledged }),
        renewLease: () => false,
      },
    });

    const res = await post(url, 'subscriptions/listen', {
      notifications: { resourceSubscriptions: [] },
    });
    await res.text();

    expect(onAcknowledged).toHaveBeenCalledOnce();
  });

  it('a throwing edge is logged and answers 500, without a stream', async () => {
    const logger = createLogger({ level: 'silent' });
    const error = vi.spyOn(logger, 'error');
    const url = await startHost({
      logger,
      listenEdge: {
        authorize: () => Promise.reject(new Error('db down')),
        onResponse: () => undefined,
        renewLease: () => false,
      },
    });

    const res = await listen(url);

    expect(res.status).toBe(500);
    expect(((await res.json()) as RpcError).error.code).toBe(-32603);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'mcp_handler_failed', err: 'db down' }),
      expect.any(String),
    );
  });

  it('a listen in a batch never reaches the SDK router unauthorized', async () => {
    const onResponse = vi.fn();
    const url = await startHost({
      listenEdge: { authorize: () => null, onResponse, renewLease: () => false },
    });

    const res = await fetch(url, {
      ...listenInit(),
      body: JSON.stringify([JSON.parse(listenInit().body as string)]),
    });

    expect(res.headers.get('content-type')).not.toContain('text/event-stream');
    expect(onResponse).not.toHaveBeenCalled();
  });

  it('is not consulted for any other method', async () => {
    const authorize = vi.fn(() => null);
    const renewLease = vi.fn(() => false);
    const url = await startHost({
      listenEdge: { authorize, onResponse: () => undefined, renewLease },
    });

    await post(url, 'tools/list', {}, { 'hive-listen-lease': 'k'.repeat(22) });

    expect(authorize).not.toHaveBeenCalled();
    expect(renewLease).not.toHaveBeenCalled();
  });

  describe('lease', () => {
    const KEY = 'k'.repeat(22);

    it('passes the lease header of a listen to the edge, and the edge headers reach the client', async () => {
      const onResponse = vi.fn((input: { raw: { setHeader(n: string, v: string): void } }) => {
        input.raw.setHeader('hive-listen-lease-ms', '60000');
        return undefined;
      });
      const url = await startHost({
        listenEdge: { authorize: () => null, onResponse, renewLease: () => false },
      });
      const init = listenInit();
      const abort = new AbortController();

      const res = await fetch(url, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), 'hive-listen-lease': KEY },
        signal: abort.signal,
      });

      expect(onResponse.mock.calls[0]?.[0]).toMatchObject({ leaseKey: KEY });
      expect(res.headers.get('hive-listen-lease-ms')).toBe('60000');
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      abort.abort();
    });

    it('a listen without the header passes no lease key', async () => {
      const onResponse = vi.fn((_input: unknown) => undefined);
      const url = await startHost({
        listenEdge: { authorize: () => null, onResponse, renewLease: () => false },
      });
      const abort = new AbortController();

      await fetch(url, { ...listenInit(), signal: abort.signal });

      expect(onResponse.mock.calls[0]?.[0]).not.toHaveProperty('leaseKey');
      abort.abort();
    });

    it('server/discover with the header renews as the authenticated caller, and still answers', async () => {
      const renewLease = vi.fn(() => true);
      const url = await startHost({
        listenEdge: { authorize: () => null, onResponse: () => undefined, renewLease },
      });

      const res = await post(url, 'server/discover', {}, { 'hive-listen-lease': KEY });

      expect(renewLease).toHaveBeenCalledWith({ key: KEY, identity: IDENTITY });
      expect(res.status).toBe(200);
      expect(JSON.stringify(await res.json())).toContain('supportedVersions');
    });

    it('a renewal that matches no lease is logged at debug, without the key', async () => {
      const logger = createLogger({ level: 'silent' });
      const debug = vi.spyOn(logger, 'debug');
      const url = await startHost({
        logger,
        listenEdge: { authorize: () => null, onResponse: () => undefined, renewLease: () => false },
      });

      await post(url, 'server/discover', {}, { 'hive-listen-lease': KEY });

      const call = debug.mock.calls.find(
        ([fields]) => (fields as { event?: string }).event === 'mcp_listen_lease_unmatched',
      );
      expect(call?.[0]).toEqual({
        event: 'mcp_listen_lease_unmatched',
        participantId: PARTICIPANT_ID,
      });
      expect(JSON.stringify(call)).not.toContain(KEY);
    });

    it('a renewal that matches logs nothing at debug', async () => {
      const logger = createLogger({ level: 'silent' });
      const debug = vi.spyOn(logger, 'debug');
      const url = await startHost({
        logger,
        listenEdge: { authorize: () => null, onResponse: () => undefined, renewLease: () => true },
      });

      await post(url, 'server/discover', {}, { 'hive-listen-lease': KEY });

      expect(
        debug.mock.calls.some(
          ([fields]) => (fields as { event?: string }).event === 'mcp_listen_lease_unmatched',
        ),
      ).toBe(false);
    });

    it('server/discover without the header renews nothing', async () => {
      const renewLease = vi.fn(() => true);
      const url = await startHost({
        listenEdge: { authorize: () => null, onResponse: () => undefined, renewLease },
      });

      await post(url, 'server/discover');

      expect(renewLease).not.toHaveBeenCalled();
    });

    it('an unauthenticated server/discover never reaches the edge', async () => {
      const renewLease = vi.fn(() => true);
      const url = await startHost({
        verify: () => Promise.reject(new AuthError('CREDENTIAL_REVOKED')),
        listenEdge: { authorize: () => null, onResponse: () => undefined, renewLease },
      });

      const res = await post(url, 'server/discover', {}, { 'hive-listen-lease': KEY });

      expect(res.status).toBe(401);
      expect(renewLease).not.toHaveBeenCalled();
    });
  });
});
