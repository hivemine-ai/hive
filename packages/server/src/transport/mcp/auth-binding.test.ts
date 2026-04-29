import { describe, it, expect, vi, type Mock } from 'vitest';

import { AuthError } from '#domain/auth/index.js';
import type { IdentityContext, Verifier } from '#domain/auth/index.js';

import { verifyBearerHeader } from './auth-binding.js';

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
