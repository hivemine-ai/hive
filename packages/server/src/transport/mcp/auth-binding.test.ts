import { describe, it, expect, vi, type Mock } from 'vitest';

import { AuthError } from '#domain/auth/index.js';
import type { IdentityContext, Verifier } from '#domain/auth/index.js';

import { verifyBearerHeader } from './auth-binding.js';

interface MockVerifier {
  verify: Mock<Verifier['verify']>;
}

const UUID_V7_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fakeIdentity(): IdentityContext {
  return {
    participantId: '01950000-0000-7000-8000-000000000001',
    kind: 'worker',
    hiveId: '01950000-0000-7000-8000-00000000aaaa',
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

  it('generates a UUID v7 requestId when none is provided', async () => {
    const verifier: MockVerifier = { verify: vi.fn().mockResolvedValue(fakeIdentity()) };

    const result = await verifyBearerHeader(verifier, 'Bearer token');

    expect(result.requestId).toMatch(UUID_V7_REGEX);
  });

  it('preserves the explicit requestId when provided', async () => {
    const verifier: MockVerifier = { verify: vi.fn().mockResolvedValue(fakeIdentity()) };
    const explicitId = '01950000-0000-7000-8000-000000000fff';

    const result = await verifyBearerHeader(verifier, 'Bearer token', explicitId);

    expect(result.requestId).toBe(explicitId);
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
