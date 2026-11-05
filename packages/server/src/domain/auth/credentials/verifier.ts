// Verifier — the 7-step pipeline of "Verificación en cada operación" from the
// Identidad y Autenticación product spec, materialized per the Auth + Identity tech spec.
//
// 1. Bearer header present?     → CREDENTIAL_MISSING
// 2. Parse token from header
// 3. jose.jwtVerify (signature, alg whitelist, iss/aud, exp, nbf), then the ADR-026
//    `scope` claim (only "enroll" is known):
//      JWSSignatureVerificationFailed → CREDENTIAL_INAUTHENTIC{signature}
//      JWTExpired                     → CREDENTIAL_EXPIRED
//      JWTClaimValidationFailed (nbf) → CREDENTIAL_NOT_YET_VALID
//      JWTClaimValidationFailed (iss/aud) → CREDENTIAL_INAUTHENTIC{iss_aud_mismatch}
//      kid lookup miss                → CREDENTIAL_INAUTHENTIC{kid_unknown}
//      JOSEAlgNotAllowed / JWSInvalid / JWTInvalid → CREDENTIAL_INAUTHENTIC{malformed}
//      unknown scope                  → CREDENTIAL_INAUTHENTIC{malformed}
// 4. await blocklist.contains(jti)? → CREDENTIAL_REVOKED; a database failure propagates
//    unmapped (fail closed, wire -32603), it is never reported as an auth failure
// 5. participantsRepo.findById(sub)
// 6. exists?                    → PARTICIPANT_NOT_FOUND
// 7. state == 'active'?         → PARTICIPANT_NOT_ACTIVE{subCode: state}
// → IdentityContext
//
// The verifier is purely composed: no DB / fs side-effects beyond what its dependencies do.
// All errors are AuthError instances; the transport maps them to wire codes (per "Mapping
// de errores" table).

import * as jose from 'jose';

import type { Kysely } from 'kysely';

import type { Logger } from '#observability/logger.js';
import type { Database } from '#persistence/schema.js';
import { requireAdminCaller } from '../caller-context.js';
import { AuthError } from '../errors.js';
import type { SigningKey } from '#domain/auth/keys/keypair-store.js';
import type { Hive, Participant } from '#domain/auth/participants/entities.js';
import type { CredentialSnapshot, IdentityContext, ParticipantKind, UUIDv7 } from '../types.js';

import type { Blocklist } from './blocklist.js';

const BEARER_PATTERN = /^[Bb]earer\s+(.+)$/;

export interface VerifierDeps {
  signingKeys: Map<string, SigningKey>;
  blocklist: Blocklist;
  participantsRepo: {
    findById(id: UUIDv7): Promise<Participant | null>;
    /**
     * Looked up once per verify() to populate {@link IdentityContext.hiveName}
     * (per ADR-015 — required for the agent-reference disambiguation algorithm).
     */
    findHiveById(id: UUIDv7): Promise<Hive | null>;
  };
  hiveStableIdentifier: UUIDv7;
  clockToleranceSeconds?: number;
  logger?: Logger;
  // ADR-026 renewal: verifyRenewalBearer reads the token row and the revocation reason.
  db?: Kysely<Database>;
  // HIVE_HOLDER_PROOF_WINDOW_DAYS. Default 7.
  holderProofWindowDays?: number;
  // Clock of verifyRenewalBearer. Injectable for tests.
  now?: () => Date;
}

export type ReverifyStreamResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'credential_expired'
        | 'credential_revoked'
        | 'participant_not_found'
        | 'participant_suspended'
        | 'participant_revoked';
    };

export interface ReverifyStreamInput {
  jti: UUIDv7;
  participantId: UUIDv7;
  credentialExpiresAt: Date;
}

export interface Verifier {
  verify(authorizationHeader: string | undefined): Promise<IdentityContext>;
  /**
   * ADR-026 renewal variant: accepts the last Worker token issued for the Agent
   * (`agents.last_worker_jti`), not revoked or superseded, even expired up to
   * HIVE_HOLDER_PROOF_WINDOW_DAYS after its `exp`, with the Agent `active` and
   * `origin = 'enrollment'`. Only the `register_session` binding uses it.
   */
  verifyRenewalBearer(authorizationHeader: string | undefined): Promise<IdentityContext>;
  /** `verify` plus the admin check; a scoped credential fails with `scoped_credential`. */
  verifyAndRequireAdmin(authorizationHeader: string | undefined): Promise<IdentityContext>;
  /**
   * Steps 4 to 7 for a stream that is already open: a stream never passes through
   * `verify`, and this is the guarantee for changes made by another process. No Bearer
   * and no signature check, only what the stream retained. A verdict is a return value
   * in the order of the steps, cheapest first; a lookup failure throws, because an
   * infrastructure failure is no reason to close a stream.
   */
  reverifyStream(input: ReverifyStreamInput): Promise<ReverifyStreamResult>;
}

export function createVerifier(deps: VerifierDeps): Verifier {
  const clockToleranceSec = deps.clockToleranceSeconds ?? 5;

  const holderProofWindowMs = (deps.holderProofWindowDays ?? 7) * 24 * 60 * 60 * 1000;

  const verifier: Verifier = {
    async verifyRenewalBearer(authorizationHeader): Promise<IdentityContext> {
      const { db } = deps;
      if (!db) throw new Error('verifyRenewalBearer requires VerifierDeps.db');
      const now = deps.now ? deps.now() : new Date();
      const { token, kid, signingKey } = parseBearerAndKey(deps, authorizationHeader);
      const invalid = (): AuthError =>
        fail(deps, new AuthError('CREDENTIAL_INAUTHENTIC', { subCode: 'holder_proof_invalid' }));
      const superseded = (): AuthError =>
        fail(deps, new AuthError('CREDENTIAL_INAUTHENTIC', { subCode: 'holder_proof_superseded' }));

      // Step 3c': like verify, except that `exp` may lie inside the holder-proof window.
      // jose checks `exp` last, after the signature, iss/aud and nbf, so a JWTExpired
      // carries a payload that passed every other check.
      let payload: jose.JWTPayload;
      try {
        const verified = await jose.jwtVerify(token, signingKey.publicKey, {
          issuer: deps.hiveStableIdentifier,
          audience: deps.hiveStableIdentifier,
          algorithms: ['EdDSA'],
          clockTolerance: `${clockToleranceSec}s`,
          currentDate: now,
        });
        payload = verified.payload;
      } catch (cause) {
        if (!(cause instanceof jose.errors.JWTExpired) || cause.claim !== 'exp') {
          throw fail(deps, mapJoseError(cause));
        }
        payload = cause.payload;
        const exp = typeof payload.exp === 'number' ? payload.exp * 1000 : 0;
        if (now.getTime() > exp + holderProofWindowMs + clockToleranceSec * 1000) {
          throw fail(
            deps,
            new AuthError('CREDENTIAL_INAUTHENTIC', { subCode: 'holder_proof_expired', cause }),
          );
        }
      }

      // Step 3d: only Worker tokens issued by register_session.
      const claims = payload as { kind?: unknown; scope?: unknown };
      const jti = payload.jti;
      const sub = payload.sub;
      if (typeof jti !== 'string' || typeof sub !== 'string') {
        throw fail(deps, new AuthError('CREDENTIAL_INAUTHENTIC', { subCode: 'malformed' }));
      }
      if (claims.kind !== 'worker' || claims.scope !== undefined) throw invalid();
      const row = await db
        .selectFrom('credentials')
        .select('enrolled_via')
        .where('jti', '=', jti)
        .executeTakeFirst();
      if (!row?.enrolled_via) throw invalid();

      // Step 4': a superseded proof is not a revoked credential.
      const revocation = await db
        .selectFrom('credential_revocations')
        .select('reason')
        .where('jti', '=', jti)
        .executeTakeFirst();
      if (revocation !== undefined) {
        if (revocation.reason === 'superseded') throw superseded();
        throw fail(deps, new AuthError('CREDENTIAL_REVOKED'));
      }

      // Steps 5-7 as in verify, then 7' and 8'.
      const participant = await deps.participantsRepo.findById(sub);
      if (!participant) throw fail(deps, new AuthError('PARTICIPANT_NOT_FOUND'));
      if (participant.kind !== 'agent') throw invalid();
      const { agent } = participant;
      if (agent.state !== 'active') {
        throw fail(deps, new AuthError('PARTICIPANT_NOT_ACTIVE', { subCode: agent.state }));
      }
      if (agent.origin !== 'enrollment') throw invalid();
      if (agent.lastWorkerJti !== jti) throw superseded();

      const hive = await deps.participantsRepo.findHiveById(deps.hiveStableIdentifier);
      if (!hive) {
        throw new Error(`DB anomaly: Hive ${deps.hiveStableIdentifier} row missing during verify`);
      }
      const identity = buildIdentityContext(participant, hive, payload, kid);
      return { ...identity, snapshot: { ...identity.snapshot, renewal: true } };
    },

    async verifyAndRequireAdmin(authorizationHeader): Promise<IdentityContext> {
      const identity = await verifier.verify(authorizationHeader);
      try {
        requireAdminCaller({ kind: 'authenticated', identity });
      } catch (err) {
        throw err instanceof AuthError ? fail(deps, err) : err;
      }
      return identity;
    },

    async verify(authorizationHeader): Promise<IdentityContext> {
      const { token, kid, signingKey } = parseBearerAndKey(deps, authorizationHeader);

      let payload: jose.JWTPayload;
      try {
        const verified = await jose.jwtVerify(token, signingKey.publicKey, {
          issuer: deps.hiveStableIdentifier,
          audience: deps.hiveStableIdentifier,
          algorithms: ['EdDSA'],
          clockTolerance: `${clockToleranceSec}s`,
        });
        payload = verified.payload;
      } catch (cause) {
        throw fail(deps, mapJoseError(cause));
      }
      const scope = (payload as { scope?: unknown }).scope;
      if (scope !== undefined && scope !== 'enroll') {
        throw fail(deps, new AuthError('CREDENTIAL_INAUTHENTIC', { subCode: 'malformed' }));
      }

      // Step 4: blocklist
      const jti = payload.jti;
      if (!jti || typeof jti !== 'string') {
        throw fail(deps, new AuthError('CREDENTIAL_INAUTHENTIC', { subCode: 'malformed' }));
      }
      if (await deps.blocklist.contains(jti)) {
        throw fail(deps, new AuthError('CREDENTIAL_REVOKED'));
      }

      // Step 5: participant lookup
      const sub = payload.sub;
      if (!sub) {
        throw fail(deps, new AuthError('CREDENTIAL_INAUTHENTIC', { subCode: 'malformed' }));
      }
      const participant = await deps.participantsRepo.findById(sub);

      // Step 6: exists?
      if (!participant) {
        throw fail(deps, new AuthError('PARTICIPANT_NOT_FOUND'));
      }

      // Step 7: active?
      const state =
        participant.kind === 'hivekeeper' ? participant.hivekeeper.state : participant.agent.state;
      if (state !== 'active') {
        throw fail(deps, new AuthError('PARTICIPANT_NOT_ACTIVE', { subCode: state }));
      }

      // Per ADR-015 — load the Hive row to populate IdentityContext.hiveName.
      // Single-hive deployment: participant.hiveId === hiveStableIdentifier
      // (FK-enforced; the lookup is a one-row PK fetch on the warm hot path).
      const hive = await deps.participantsRepo.findHiveById(deps.hiveStableIdentifier);
      if (!hive) {
        throw new Error(`DB anomaly: Hive ${deps.hiveStableIdentifier} row missing during verify`);
      }

      const identity = buildIdentityContext(participant, hive, payload, kid);
      if (deps.logger) {
        deps.logger.info(
          {
            event: 'auth_credential_verified',
            participantId: identity.participantId,
            kind: identity.kind,
            kid,
          },
          'auth credential verified',
        );
      }
      return identity;
    },

    async reverifyStream({ jti, participantId, credentialExpiresAt }) {
      // No clock tolerance: a stream is stricter than a new request.
      if (Date.now() >= credentialExpiresAt.getTime()) {
        return { ok: false, reason: 'credential_expired' };
      }
      if (await deps.blocklist.contains(jti)) {
        return { ok: false, reason: 'credential_revoked' };
      }
      const participant = await deps.participantsRepo.findById(participantId);
      if (!participant) return { ok: false, reason: 'participant_not_found' };
      const state =
        participant.kind === 'hivekeeper' ? participant.hivekeeper.state : participant.agent.state;
      if (state === 'suspended') return { ok: false, reason: 'participant_suspended' };
      if (state === 'revoked') return { ok: false, reason: 'participant_revoked' };
      return { ok: true };
    },
  };
  return verifier;
}

function parseBearerAndKey(
  deps: VerifierDeps,
  authorizationHeader: string | undefined,
): { token: string; kid: string; signingKey: SigningKey } {
  // Step 1: Bearer header present?
  if (!authorizationHeader) {
    throw fail(deps, new AuthError('CREDENTIAL_MISSING'));
  }
  const match = BEARER_PATTERN.exec(authorizationHeader);
  if (!match || match[1] === undefined) {
    throw fail(deps, new AuthError('CREDENTIAL_MISSING'));
  }
  const token = match[1].trim();
  if (token.length === 0) {
    throw fail(deps, new AuthError('CREDENTIAL_MISSING'));
  }

  // Steps 2-3b: kid lookup; the caller runs jose.jwtVerify
  let protectedHeader: jose.ProtectedHeaderParameters;
  try {
    protectedHeader = jose.decodeProtectedHeader(token);
  } catch (cause) {
    throw fail(deps, new AuthError('CREDENTIAL_INAUTHENTIC', { subCode: 'malformed', cause }));
  }
  const kid = protectedHeader.kid;
  if (!kid || typeof kid !== 'string') {
    throw fail(deps, new AuthError('CREDENTIAL_INAUTHENTIC', { subCode: 'malformed' }));
  }
  const signingKey = deps.signingKeys.get(kid);
  if (!signingKey) {
    throw fail(deps, new AuthError('CREDENTIAL_INAUTHENTIC', { subCode: 'kid_unknown' }));
  }
  return { token, kid, signingKey };
}

function mapJoseError(cause: unknown): AuthError {
  if (cause instanceof jose.errors.JWTExpired) {
    return new AuthError('CREDENTIAL_EXPIRED', { cause });
  }
  if (cause instanceof jose.errors.JWSSignatureVerificationFailed) {
    return new AuthError('CREDENTIAL_INAUTHENTIC', {
      subCode: 'signature',
      cause,
    });
  }
  if (cause instanceof jose.errors.JWTClaimValidationFailed) {
    // jose sets `claim` and `code`; map nbf to NOT_YET_VALID, otherwise iss/aud mismatch.
    const claim = cause.claim;
    if (claim === 'nbf') {
      return new AuthError('CREDENTIAL_NOT_YET_VALID', { cause });
    }
    if (claim === 'iss' || claim === 'aud') {
      return new AuthError('CREDENTIAL_INAUTHENTIC', {
        subCode: 'iss_aud_mismatch',
        cause,
      });
    }
    return new AuthError('CREDENTIAL_INAUTHENTIC', {
      subCode: 'malformed',
      cause,
    });
  }
  if (
    cause instanceof jose.errors.JOSEAlgNotAllowed ||
    cause instanceof jose.errors.JWSInvalid ||
    cause instanceof jose.errors.JWTInvalid
  ) {
    return new AuthError('CREDENTIAL_INAUTHENTIC', {
      subCode: 'malformed',
      cause,
    });
  }
  return new AuthError('CREDENTIAL_INAUTHENTIC', { subCode: 'malformed', cause });
}

function buildIdentityContext(
  p: Participant,
  hive: Hive,
  payload: jose.JWTPayload,
  kid: string,
): IdentityContext {
  const issuedAt = typeof payload.iat === 'number' ? new Date(payload.iat * 1000) : new Date();
  const credentialJti = payload.jti as UUIDv7;
  const credentialExpiresAt =
    typeof payload.exp === 'number' ? { credentialExpiresAt: new Date(payload.exp * 1000) } : {};

  if (p.kind === 'hivekeeper') {
    const hk = p.hivekeeper;
    const claims = payload as { scope?: 'enroll'; name_prefix?: unknown; max_agents?: unknown };
    const snapshot: CredentialSnapshot = {
      issuedAt,
      credentialJti,
      credentialKid: kid,
      ...credentialExpiresAt,
      ...(claims.scope !== undefined ? { scope: claims.scope } : {}),
      ...(typeof claims.name_prefix === 'string' ? { namePrefix: claims.name_prefix } : {}),
      ...(typeof claims.max_agents === 'number' ? { maxAgents: claims.max_agents } : {}),
    };
    return {
      participantId: hk.id,
      kind: 'hivekeeper',
      hiveId: hk.hiveId,
      hiveName: hive.name,
      colonyId: hk.colonyId,
      snapshot,
      // ADR-026: a scoped credential carries no admin authority, so `isAdmin` stays unset.
      current:
        claims.scope !== undefined ? { state: 'active' } : { state: 'active', isAdmin: hk.isAdmin },
    };
  }

  const ag = p.agent;
  const capsClaim = (payload as { capabilities?: unknown }).capabilities;
  const snapshot: CredentialSnapshot = {
    issuedAt,
    credentialJti,
    credentialKid: kid,
    ...credentialExpiresAt,
    ...(Array.isArray(capsClaim) ? { capabilities: capsClaim as string[] } : {}),
  };
  // The IdentityContext.kind reflects what the JWT claimed (snapshot at issuance);
  // current.type reflects the live DB row. They should normally match.
  const claimedKind = (payload as { kind?: ParticipantKind }).kind;
  const kind: ParticipantKind =
    claimedKind === 'worker' || claimedKind === 'scout' ? claimedKind : ag.type;
  return {
    participantId: ag.id,
    kind,
    hiveId: ag.hiveId,
    hiveName: hive.name,
    colonyId: ag.colonyId,
    ownerId: ag.ownerId,
    snapshot,
    current: { state: 'active', type: ag.type },
  };
}

function fail(deps: VerifierDeps, err: AuthError): AuthError {
  // Audit log of rejections — informational, never includes the raw token.
  if (deps.logger) {
    const fields: Record<string, unknown> = { code: err.code };
    if (err.subCode !== undefined) fields['subCode'] = err.subCode;
    deps.logger.warn(fields, 'auth verify rejected');
  }
  return err;
}
