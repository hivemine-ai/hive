// Verifier — the 7-step pipeline of "Verificación en cada operación" from the
// Identidad y Autenticación product spec, materialized per the Auth + Identity tech spec.
//
// 1. Bearer header present?     → CREDENTIAL_MISSING
// 2. Parse token from header
// 3. jose.jwtVerify (signature, alg whitelist, iss/aud, exp, nbf):
//      JWSSignatureVerificationFailed → CREDENTIAL_INAUTHENTIC{signature}
//      JWTExpired                     → CREDENTIAL_EXPIRED
//      JWTClaimValidationFailed (nbf) → CREDENTIAL_NOT_YET_VALID
//      JWTClaimValidationFailed (iss/aud) → CREDENTIAL_INAUTHENTIC{iss_aud_mismatch}
//      kid lookup miss                → CREDENTIAL_INAUTHENTIC{kid_unknown}
//      JOSEAlgNotAllowed / JWSInvalid / JWTInvalid → CREDENTIAL_INAUTHENTIC{malformed}
// 4. blocklist.contains(jti)?   → CREDENTIAL_REVOKED
// 5. participantsRepo.findById(sub)
// 6. exists?                    → PARTICIPANT_NOT_FOUND
// 7. state == 'active'?         → PARTICIPANT_NOT_ACTIVE{subCode: state}
// → IdentityContext
//
// The verifier is purely composed: no DB / fs side-effects beyond what its dependencies do.
// All errors are AuthError instances; the transport maps them to wire codes (per "Mapping
// de errores" table).

import * as jose from 'jose';

import type { Logger } from '#observability/logger.js';
import { AuthError } from '../errors.js';
import type { SigningKey } from '../keys/keypair-store.js';
import type { Participant } from '../participants/entities.js';
import type { CredentialSnapshot, IdentityContext, ParticipantKind, UUIDv7 } from '../types.js';

import type { Blocklist } from './blocklist.js';

const BEARER_PATTERN = /^[Bb]earer\s+(.+)$/;

export interface VerifierDeps {
  signingKeys: Map<string, SigningKey>;
  blocklist: Blocklist;
  participantsRepo: { findById(id: UUIDv7): Promise<Participant | null> };
  hiveStableIdentifier: UUIDv7;
  clockToleranceSeconds?: number;
  logger?: Logger;
}

export interface Verifier {
  verify(authorizationHeader: string | undefined): Promise<IdentityContext>;
}

export function createVerifier(deps: VerifierDeps): Verifier {
  const clockToleranceSec = deps.clockToleranceSeconds ?? 5;

  return {
    async verify(authorizationHeader): Promise<IdentityContext> {
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

      // Step 2-3: kid lookup + jose verify
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

      // Step 4: blocklist
      const jti = payload.jti;
      if (!jti || typeof jti !== 'string') {
        throw fail(deps, new AuthError('CREDENTIAL_INAUTHENTIC', { subCode: 'malformed' }));
      }
      if (deps.blocklist.contains(jti)) {
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

      const identity = buildIdentityContext(participant, payload, kid);
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
  };
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
  payload: jose.JWTPayload,
  kid: string,
): IdentityContext {
  const issuedAt = typeof payload.iat === 'number' ? new Date(payload.iat * 1000) : new Date();
  const credentialJti = payload.jti as UUIDv7;

  if (p.kind === 'hivekeeper') {
    const hk = p.hivekeeper;
    const snapshot: CredentialSnapshot = {
      issuedAt,
      credentialJti,
      credentialKid: kid,
    };
    return {
      participantId: hk.id,
      kind: 'hivekeeper',
      hiveId: hk.hiveId,
      colonyId: hk.colonyId,
      snapshot,
      current: { state: 'active', isAdmin: hk.isAdmin },
    };
  }

  const ag = p.agent;
  const capsClaim = (payload as { capabilities?: unknown }).capabilities;
  const snapshot: CredentialSnapshot = {
    issuedAt,
    credentialJti,
    credentialKid: kid,
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
