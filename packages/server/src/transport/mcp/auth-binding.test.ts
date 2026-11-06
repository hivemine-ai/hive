import { describe, it, expect, vi, type Mock } from 'vitest';

import { AuthError } from '#domain/auth/index.js';
import type { IdentityContext, Verifier } from '#domain/auth/index.js';

import type { Logger } from '#observability/logger.js';

import {
  createLastConnectedRefresher,
  requestOperation,
  verifyBearerHeader,
} from './auth-binding.js';

interface MockVerifier {
  verify: Mock<Verifier['verify']>;
  verifyRenewalBearer: Mock<Verifier['verifyRenewalBearer']>;
}

function mockVerifier(verify: Mock<Verifier['verify']>): MockVerifier {
  return { verify, verifyRenewalBearer: vi.fn() };
}

const TOOLS_LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list' };

function toolCall(name: string): unknown {
  return { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } };
}

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

// Unsigned on purpose: the binding only peeks at the claims to route the request.
function bearerWithClaims(claims: Record<string, unknown>): string {
  return `Bearer ${b64url({ alg: 'EdDSA', typ: 'JWT' })}.${b64url(claims)}.c2ln`;
}

function fakeIdentity(): IdentityContext {
  return {
    participantId: '01950000-0000-7000-8000-000000000001',
    kind: 'worker',
    hiveId: '01950000-0000-7000-8000-00000000aaaa',
    hiveName: 'test-hive',
    colonyId: '01950000-0000-7000-8000-00000000bbbb',
    ownerId: '01950000-0000-7000-8000-00000000cccc',
    snapshot: {} as IdentityContext['snapshot'],
    current: {} as IdentityContext['current'],
  };
}

describe('verifyBearerHeader', () => {
  it('returns the identity from the verifier on success', async () => {
    const identity = fakeIdentity();
    const verifier = mockVerifier(vi.fn().mockResolvedValue(identity));

    const result = await verifyBearerHeader(verifier, 'Bearer token123', TOOLS_LIST);

    expect(result.identity).toBe(identity);
    expect(verifier.verify).toHaveBeenCalledWith('Bearer token123');
  });

  it('propagates AuthError(CREDENTIAL_MISSING) when header is undefined', async () => {
    const verifier = mockVerifier(vi.fn().mockRejectedValue(new AuthError('CREDENTIAL_MISSING')));

    await expect(verifyBearerHeader(verifier, undefined, TOOLS_LIST)).rejects.toMatchObject({
      code: 'CREDENTIAL_MISSING',
    });
  });

  it('propagates AuthError(CREDENTIAL_INAUTHENTIC) on verify failure', async () => {
    const verifier = mockVerifier(
      vi.fn().mockRejectedValue(new AuthError('CREDENTIAL_INAUTHENTIC', { subCode: 'signature' })),
    );

    await expect(verifyBearerHeader(verifier, 'Bearer broken', TOOLS_LIST)).rejects.toMatchObject({
      code: 'CREDENTIAL_INAUTHENTIC',
      subCode: 'signature',
    });
  });

  it('passes the header verbatim to the verifier (does not strip prefix)', async () => {
    const verifier = mockVerifier(vi.fn().mockResolvedValue(fakeIdentity()));

    await verifyBearerHeader(verifier, 'Bearer abc.def.ghi', TOOLS_LIST);

    expect(verifier.verify).toHaveBeenCalledWith('Bearer abc.def.ghi');
  });

  it('passes undefined header verbatim (lets the verifier decide)', async () => {
    const verifier = mockVerifier(vi.fn().mockRejectedValue(new AuthError('CREDENTIAL_MISSING')));

    await expect(verifyBearerHeader(verifier, undefined, TOOLS_LIST)).rejects.toBeInstanceOf(
      AuthError,
    );
    expect(verifier.verify).toHaveBeenCalledWith(undefined);
  });
});

describe('enroll scope binding (ADR-026)', () => {
  function enrollIdentity(): IdentityContext {
    const identity = fakeIdentity();
    return {
      ...identity,
      kind: 'hivekeeper',
      snapshot: { scope: 'enroll' } as IdentityContext['snapshot'],
    };
  }
  const ENROLL_BEARER = bearerWithClaims({ sub: 'owner', scope: 'enroll' });
  const WORKER_BEARER = bearerWithClaims({ sub: 'agent', kind: 'worker' });

  it('lets an enrollment credential call register_session', async () => {
    const identity = enrollIdentity();
    const verifier = mockVerifier(vi.fn().mockResolvedValue(identity));

    const result = await verifyBearerHeader(verifier, ENROLL_BEARER, toolCall('register_session'));

    expect(result.identity).toBe(identity);
    expect(verifier.verifyRenewalBearer).not.toHaveBeenCalled();
  });

  it('lets an enrollment credential call server/discover', async () => {
    const verifier = mockVerifier(vi.fn().mockResolvedValue(enrollIdentity()));

    await expect(
      verifyBearerHeader(verifier, ENROLL_BEARER, { method: 'server/discover' }),
    ).resolves.toBeDefined();
  });

  it.each([
    ['tools/list', TOOLS_LIST],
    ['another tool', toolCall('list_agents')],
    ['resources/read', { method: 'resources/read', params: { uri: 'hive://x' } }],
    ['resources/list', { method: 'resources/list' }],
    ['subscriptions/listen', { method: 'subscriptions/listen', params: {} }],
  ])('rejects an enrollment credential on %s as scoped_credential', async (_label, body) => {
    const verifier = mockVerifier(vi.fn().mockResolvedValue(enrollIdentity()));

    await expect(verifyBearerHeader(verifier, ENROLL_BEARER, body)).rejects.toMatchObject({
      code: 'INSUFFICIENT_PRIVILEGE',
      subCode: 'scoped_credential',
    });
  });

  it('routes an unscoped Bearer on register_session to verifyRenewalBearer', async () => {
    const identity = fakeIdentity();
    const verifier = mockVerifier(vi.fn());
    verifier.verifyRenewalBearer.mockResolvedValue(identity);

    const result = await verifyBearerHeader(verifier, WORKER_BEARER, toolCall('register_session'));

    expect(result.identity).toBe(identity);
    expect(verifier.verifyRenewalBearer).toHaveBeenCalledWith(WORKER_BEARER);
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it('propagates a failed holder proof as the AuthError of verifyRenewalBearer', async () => {
    const verifier = mockVerifier(vi.fn());
    verifier.verifyRenewalBearer.mockRejectedValue(
      new AuthError('CREDENTIAL_INAUTHENTIC', { subCode: 'holder_proof_superseded' }),
    );

    await expect(
      verifyBearerHeader(verifier, WORKER_BEARER, toolCall('register_session')),
    ).rejects.toMatchObject({ subCode: 'holder_proof_superseded' });
  });

  it('keeps verify for an unscoped Bearer on any other tool, so an expired token fails there', async () => {
    const verifier = mockVerifier(vi.fn().mockRejectedValue(new AuthError('CREDENTIAL_EXPIRED')));

    await expect(
      verifyBearerHeader(verifier, WORKER_BEARER, toolCall('send_message')),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_EXPIRED' });
    expect(verifier.verifyRenewalBearer).not.toHaveBeenCalled();
  });

  it('uses verify when the Bearer cannot be decoded, which then fails it', async () => {
    const verifier = mockVerifier(
      vi.fn().mockRejectedValue(new AuthError('CREDENTIAL_INAUTHENTIC', { subCode: 'malformed' })),
    );

    await expect(
      verifyBearerHeader(verifier, 'Bearer not-a-jwt', toolCall('register_session')),
    ).rejects.toMatchObject({ subCode: 'malformed' });
    expect(verifier.verifyRenewalBearer).not.toHaveBeenCalled();
  });
});

describe('requestOperation', () => {
  it.each([
    [toolCall('send_message'), 'tools_call:send_message'],
    [TOOLS_LIST, 'tools_list'],
    [{ method: 'resources/read' }, 'resources'],
    [{ method: 'resources/templates/list' }, 'resources'],
    [{ method: 'subscriptions/listen' }, 'subscriptions_listen'],
    [{ method: 'server/discover' }, 'server_discover'],
    [null, 'unknown'],
    [toolCall('register_session'), 'tools_call:register_session'],
    // Bounded for the logs: a name or method the server does not know is never echoed.
    [toolCall('x'.repeat(500)), 'tools_call:<other>'],
    [toolCall('session_status'), 'tools_call:<other>'],
    [{ method: 'tools/call', params: { name: 42 } }, 'tools_call:<other>'],
    [{ method: 'y'.repeat(500) }, 'other'],
    [{ method: 'ping' }, 'ping'],
  ])('names %j as %s', (body, operation) => {
    expect(requestOperation(body)).toBe(operation);
  });
});

describe('createLastConnectedRefresher', () => {
  const worker = { participantId: 'worker-1', kind: 'worker' } as unknown as IdentityContext;
  const scout = { participantId: 'scout-1', kind: 'scout' } as unknown as IdentityContext;
  const keeper = { participantId: 'keeper-1', kind: 'hivekeeper' } as unknown as IdentityContext;
  const logger = { warn: vi.fn() } as unknown as Logger;

  function build(updateAgentLastConnectedAt = vi.fn(() => Promise.resolve())) {
    let nowMs = Date.parse('2026-11-02T12:00:00.000Z');
    const refresher = createLastConnectedRefresher({
      participantsRepo: { updateAgentLastConnectedAt },
      logger,
      throttleMs: 1_000,
      now: () => new Date(nowMs),
    });
    return {
      refresher,
      updateAgentLastConnectedAt,
      advance: (ms: number) => {
        nowMs += ms;
      },
    };
  }

  it('writes for Workers and Scouts, never for Hivekeepers', () => {
    const { refresher, updateAgentLastConnectedAt } = build();

    refresher.refresh(worker);
    refresher.refresh(scout);
    refresher.refresh(keeper);

    expect(updateAgentLastConnectedAt.mock.calls.map((c: unknown[]) => c[0])).toEqual([
      'worker-1',
      'scout-1',
    ]);
  });

  it('throttles per participant', () => {
    const { refresher, updateAgentLastConnectedAt, advance } = build();

    refresher.refresh(worker);
    advance(999);
    refresher.refresh(worker);
    expect(updateAgentLastConnectedAt).toHaveBeenCalledTimes(1);

    advance(1);
    refresher.refresh(worker);
    expect(updateAgentLastConnectedAt).toHaveBeenCalledTimes(2);
  });

  it('never rejects, logs a failed write, and retries on the next request', async () => {
    const failing = vi.fn(() => Promise.reject(new Error('database is locked')));
    const { refresher } = build(failing);

    refresher.refresh(worker);
    await new Promise((resolve) => setImmediate(resolve));
    refresher.refresh(worker);

    expect(logger.warn).toHaveBeenCalled();
    expect(failing).toHaveBeenCalledTimes(2);
  });
});
