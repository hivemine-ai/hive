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

export type {
  Agent,
  Colony,
  Hive,
  Hivekeeper,
  Participant,
  ParticipantStateSummary,
} from './participants/entities.js';

export { createParticipantsReadRepo } from './participants/repository.js';
export type { ParticipantsReadRepo } from './participants/repository.js';

export { loadBlocklist } from './credentials/blocklist.js';
export type { AddRevocationInput, Blocklist } from './credentials/blocklist.js';

export { createVerifier } from './credentials/verifier.js';
export type { Verifier, VerifierDeps } from './credentials/verifier.js';

export { createIssuer } from './credentials/issuer.js';
export type { Issuer, IssuerDeps, IssueCredentialInput } from './credentials/issuer.js';

export { createRotator } from './credentials/rotator.js';
export type { Rotator, RotatorDeps, RotateCredentialInput } from './credentials/rotator.js';

export { createRevoker } from './credentials/revoker.js';
export type { Revoker, RevokerDeps, RevokeCredentialInput } from './credentials/revoker.js';

export { createParticipantsWriteRepo } from './participants/repository.write.js';
export type {
  AuditCursor,
  CreateAgentInput,
  CreateHivekeeperInput,
  ListAgentsFilter,
  ListAgentsResult,
  ListHivekeepersFilter,
  ListHivekeepersResult,
  ParticipantsWriteRepo,
  ParticipantsWriteRepoOptions,
} from './participants/repository.write.js';

export { noopCellsHook } from './participants/cells-hook.js';
export type {
  CellsRepoHook,
  CloseCellHookInput,
  CreateCellHookInput,
  DbExecutor,
} from './participants/cells-hook.js';
