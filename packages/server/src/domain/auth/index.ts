// Public barrel for the Auth domain.

export { AuthError, isAuthError } from './errors.js';
export type { AuthErrorCode, AuthErrorOptions } from './errors.js';

export type {
  CredentialMetadata,
  CredentialSnapshot,
  CurrentParticipantState,
  Duration,
  IdentityContext,
  IssuedCredential,
  ParticipantKind,
  ParticipantState,
  UUIDv7,
} from './types.js';

export { requireAdminCaller } from './caller-context.js';
export type { CallerContext } from './caller-context.js';

export {
  generateKeypair,
  deriveKid,
  writeKeypairToDisk,
  loadKeypairFromDisk,
  assertPrivatePemPerms,
  loadAllKeypairs,
} from './keys/keypair-store.js';
export type { SigningKey, KeypairStoreOptions } from './keys/keypair-store.js';

export { publicKeyToJwk, signingKeyToJwk, buildJwkSet } from './keys/jwks.js';
export type { JwkEntry, JwkSet } from './keys/jwks.js';
