// Enrollment — the auth side of session enrollment (ADR-026, Auth + Identity tech spec
// § `credentials/enrollment.ts`).
//
// An enrollment credential is a JWT of the same issuer whose `sub` is the owner
// Hivekeeper and that carries `scope: "enroll"` plus the optional `name_prefix` and
// `max_agents` claims. It holds no admin or Hivekeeper authority: the verifier exposes the
// scope and never populates `isAdmin`, and the transport binding only lets it call
// `register_session`.

import { requireAdminCaller } from '../caller-context.js';
import type { CallerContext } from '../caller-context.js';
import { AuthError } from '../errors.js';
import type { Duration, IssuedCredential, UUIDv7 } from '../types.js';

import { mintCredential } from './issuer.js';
import type { IssuerDeps, MintDeps } from './issuer.js';

// Agent name slug of ADR-015. A name prefix must itself be a valid start of a name.
const AGENT_NAME_RE = /^[a-z][a-z0-9-]*$/;

export interface EnrollmentDeps extends MintDeps {
  participantsRepo: IssuerDeps['participantsRepo'];
  // HIVE_ENROLLMENT_CREDENTIAL_TTL_DAYS, materialized in milliseconds by the caller.
  enrollmentTtlMs: Duration;
  // HIVE_ENROLLMENT_MAX_AGENTS: the Hive-wide ceiling of the `max_agents` claim.
  hiveMaxAgents: number;
}

export interface IssueEnrollmentCredentialInput {
  ownerId: UUIDv7;
  namePrefix?: string;
  maxAgents?: number;
  ttl?: Duration;
}

export interface Enrollment {
  issueEnrollmentCredential(
    input: IssueEnrollmentCredentialInput,
    caller: CallerContext,
  ): Promise<IssuedCredential>;
}

export function createEnrollment(deps: EnrollmentDeps): Enrollment {
  return {
    async issueEnrollmentCredential(input, caller): Promise<IssuedCredential> {
      const issuedBy = authorizeIssue(input.ownerId, caller);
      validateClaims(input, deps.hiveMaxAgents);

      const owner = await deps.participantsRepo.findById(input.ownerId);
      if (!owner || owner.kind !== 'hivekeeper') {
        throw new AuthError('PARTICIPANT_NOT_FOUND_FOR_ISSUE');
      }
      if (owner.hivekeeper.state !== 'active') {
        throw new AuthError('PARTICIPANT_NOT_ACTIVE', { subCode: owner.hivekeeper.state });
      }

      return mintCredential(deps, {
        participant: owner,
        ttlMs: input.ttl ?? deps.enrollmentTtlMs,
        issuedBy,
        enrollment: {
          ...(input.namePrefix !== undefined ? { namePrefix: input.namePrefix } : {}),
          ...(input.maxAgents !== undefined ? { maxAgents: input.maxAgents } : {}),
        },
      });
    },
  };
}

// A Hivekeeper issues only for itself; another owner needs an admin (or the system
// caller). Returns the `issued_by` of the row.
function authorizeIssue(ownerId: UUIDv7, caller: CallerContext): UUIDv7 | null {
  if (caller.kind === 'system') return null;
  const { identity } = caller;
  if (identity.snapshot.scope !== undefined) {
    throw new AuthError('INSUFFICIENT_PRIVILEGE', { subCode: 'scoped_credential' });
  }
  if (identity.kind !== 'hivekeeper' || identity.participantId !== ownerId) {
    requireAdminCaller(caller);
  }
  return identity.participantId;
}

function validateClaims(input: IssueEnrollmentCredentialInput, hiveMaxAgents: number): void {
  if (input.namePrefix !== undefined && !AGENT_NAME_RE.test(input.namePrefix)) {
    throw new AuthError('INVALID_INPUT', { subCode: 'name_prefix_invalid' });
  }
  if (input.maxAgents !== undefined) {
    if (!Number.isInteger(input.maxAgents) || input.maxAgents < 1) {
      throw new AuthError('INVALID_INPUT', { subCode: 'max_agents_invalid' });
    }
    if (input.maxAgents > hiveMaxAgents) {
      throw new AuthError('INVALID_INPUT', { subCode: 'max_agents_exceeds_hive_limit' });
    }
  }
}
