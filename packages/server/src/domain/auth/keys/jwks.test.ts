import { describe, expect, it } from 'vitest';

import { generateKeypair } from './keypair-store.js';
import { buildJwkSet, publicKeyToJwk, signingKeyToJwk } from './jwks.js';

describe('publicKeyToJwk / signingKeyToJwk', () => {
  it('produces a JWK with the canonical Ed25519 fields', () => {
    const key = generateKeypair();
    const jwk = signingKeyToJwk(key);
    expect(jwk.kty).toBe('OKP');
    expect(jwk.crv).toBe('Ed25519');
    expect(jwk.kid).toBe(key.kid);
    expect(jwk.use).toBe('sig');
    expect(jwk.alg).toBe('EdDSA');
    expect(typeof jwk.x).toBe('string');
    expect(jwk.x.length).toBeGreaterThan(0);
    // base64url has no '+', '/' or '=' padding.
    expect(jwk.x).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('publicKeyToJwk accepts a raw KeyObject with a custom kid', () => {
    const key = generateKeypair();
    const jwk = publicKeyToJwk(key.publicKey, 'my-custom-kid');
    expect(jwk.kid).toBe('my-custom-kid');
  });
});

describe('buildJwkSet', () => {
  it('returns an empty set for no keys', () => {
    const set = buildJwkSet([]);
    expect(set).toEqual({ keys: [] });
  });

  it('returns one entry per signing key', () => {
    const a = generateKeypair();
    const b = generateKeypair();
    const set = buildJwkSet([a, b]);
    expect(set.keys.length).toBe(2);
    expect(set.keys[0]?.kid).toBe(a.kid);
    expect(set.keys[1]?.kid).toBe(b.kid);
  });
});
