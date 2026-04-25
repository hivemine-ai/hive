// JWKS serialization for the public-facing well-known endpoint.
// Per the Auth + Identity tech spec: each entry is { kty:'OKP', crv:'Ed25519', kid, x, use:'sig', alg:'EdDSA' }.

import type { KeyObject } from 'node:crypto';

import type { SigningKey } from './keypair-store.js';

export interface JwkEntry {
  kty: 'OKP';
  crv: 'Ed25519';
  kid: string;
  x: string; // base64url of the raw public key bytes
  use: 'sig';
  alg: 'EdDSA';
}

export interface JwkSet {
  keys: JwkEntry[];
}

/**
 * Serializes a public Ed25519 key as a JWK entry.
 * The `x` value comes from node:crypto's JWK export (already base64url-encoded).
 */
export function publicKeyToJwk(publicKey: KeyObject, kid: string): JwkEntry {
  const jwk = publicKey.export({ format: 'jwk' });
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
    throw new Error(`Unexpected JWK shape from node:crypto export: ${JSON.stringify(jwk)}`);
  }
  return {
    kty: 'OKP',
    crv: 'Ed25519',
    kid,
    x: jwk.x,
    use: 'sig',
    alg: 'EdDSA',
  };
}

export function signingKeyToJwk(key: SigningKey): JwkEntry {
  return publicKeyToJwk(key.publicKey, key.kid);
}

export function buildJwkSet(keys: Iterable<SigningKey>): JwkSet {
  const entries: JwkEntry[] = [];
  for (const key of keys) {
    entries.push(signingKeyToJwk(key));
  }
  return { keys: entries };
}
