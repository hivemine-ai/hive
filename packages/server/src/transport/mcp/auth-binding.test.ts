import { describe, it, expect, vi, type Mock } from 'vitest';

import { AuthError } from '#domain/auth/index.js';
import type { IdentityContext, Verifier } from '#domain/auth/index.js';

import type { Logger } from '#observability/logger.js';

import { createLastConnectedRefresher, verifyBearerHeader } from './auth-binding.js';

interface MockVerifier {
  verify: Mock<Verifier['verify']>;
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
    const verifier: MockVerifier = { verify: vi.fn().mockResolvedValue(identity) };

    const result = await verifyBearerHeader(verifier, 'Bearer token123');

    expect(result.identity).toBe(identity);
    expect(verifier.verify).toHaveBeenCalledWith('Bearer token123');
  });

  it('propagates AuthError(CREDENTIAL_MISSING) when header is undefined', async () => {
    const verifier: MockVerifier = {
      verify: vi.fn().mockRejectedValue(new AuthError('CREDENTIAL_MISSING')),
    };

    await expect(verifyBearerHeader(verifier, undefined)).rejects.toMatchObject({
      code: 'CREDENTIAL_MISSING',
    });
  });

  it('propagates AuthError(CREDENTIAL_INAUTHENTIC) on verify failure', async () => {
    const verifier: MockVerifier = {
      verify: vi
        .fn()
        .mockRejectedValue(new AuthError('CREDENTIAL_INAUTHENTIC', { subCode: 'signature' })),
    };

    await expect(verifyBearerHeader(verifier, 'Bearer broken')).rejects.toMatchObject({
      code: 'CREDENTIAL_INAUTHENTIC',
      subCode: 'signature',
    });
  });

  it('passes the header verbatim to the verifier (does not strip prefix)', async () => {
    const verifier: MockVerifier = { verify: vi.fn().mockResolvedValue(fakeIdentity()) };

    await verifyBearerHeader(verifier, 'Bearer abc.def.ghi');

    expect(verifier.verify).toHaveBeenCalledWith('Bearer abc.def.ghi');
  });

  it('passes undefined header verbatim (lets the verifier decide)', async () => {
    const verifier: MockVerifier = {
      verify: vi.fn().mockRejectedValue(new AuthError('CREDENTIAL_MISSING')),
    };

    await expect(verifyBearerHeader(verifier, undefined)).rejects.toBeInstanceOf(AuthError);
    expect(verifier.verify).toHaveBeenCalledWith(undefined);
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
