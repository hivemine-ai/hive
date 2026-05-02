// Resolve a participant reference to a canonical UUIDv7 — CLI side.
//
// Per ADR-020, the parser itself lives in `@hive/server`'s
// `domain/auth/references/parser.ts` (single source of truth shared with the
// MCP wire). The CLI layer wraps it with the caller context loaded from the
// runtime + repo lookups + uniform error mapping.
//
// `--operator-id` (resolveOperatorId): UUID OR Hivekeeper email. 'self' /
// agent-reference are not applicable (operators are always Hivekeepers per
// ADR-007).
//
// `--owner` / `--participant-id` / `<participant-ref>` (resolveParticipantReference):
// UUID OR Hivekeeper email today. Credential-active alias is rejected here —
// see `resolveCredentialRef` for the `<participant-ref>:latest` flow.
//
// `<agent-ref>` positional in `agent revoke` (resolveAgentReference, PRY-040):
// UUID OR agent-reference syntax (`<name>@<owner-local>.<hive>`). Email and
// 'self' / 'credential-active' kinds are not applicable.
//
// `<jti-or-active-ref>` positional in `credential rotate` / `credential revoke`
// (resolveCredentialRef, PRY-041): UUID directly (treated as a JTI without DB
// lookup, preserving idempotent semantics) OR `<participant-ref>:latest`
// (resolves the inner participant + the active credential JTI via the new
// credentialsRepo).
//
// `--actor-id` / `--subject-id` flags in `audit query`
// (resolveAuditParticipantReference, PRY-042): UUID OR Hivekeeper email OR
// agent reference. Both flags accept the same 3 kinds — the only difference is
// the field name baked into error subCodes / messages (so investigators can
// distinguish which flag failed without re-reading the invocation).

import { AuthError, parseReference, type ParsedReference } from '@hive/server';
import type { CliRuntime, UUIDv7 } from '@hive/server';

import { getCliCallerContext } from '../composition/caller-context.js';
import { CliError } from '#error/cli-error.js';

export type { ParsedReference };

export type ParticipantReferenceKind = 'uuid' | 'email';

export interface ParsedParticipantReference {
  kind: ParticipantReferenceKind;
  raw: string;
}

/**
 * Parse a participant reference accepted by `--owner` / `--participant-id` /
 * `<participant-ref>` (UUID OR Hivekeeper email). Delegates to the shared
 * `parseReference` and projects the result to the legacy 2-kind shape.
 *
 * `hiveName` is required by the shared parser to disambiguate agent-references
 * from emails. Callers in PRY-039 do not yet accept agent-references; the
 * parser still rejects them as `reference_unparseable` here so behavior is
 * preserved. PRY-041/042 will introduce wider-scoped helpers.
 */
export function parseParticipantReference(
  input: string,
  hiveName: string,
): ParsedParticipantReference {
  const parsed = parseReference(input, hiveName);
  if (parsed === null) {
    throw new CliError('CONFIG_INVALID', {
      subCode: 'reference_unparseable',
      message: `'${input}' is neither a UUID v7 nor a valid email`,
    });
  }
  if (parsed.kind === 'uuid') return { kind: 'uuid', raw: parsed.id };
  if (parsed.kind === 'hivekeeper-email') return { kind: 'email', raw: parsed.email };
  // 'self' or 'agent-reference' — out of scope for the legacy 2-kind callers.
  throw new CliError('CONFIG_INVALID', {
    subCode: 'reference_unparseable',
    message: `'${input}' is neither a UUID v7 nor a valid email`,
  });
}

/**
 * Resolve any of the supported reference forms (UUID OR Hivekeeper email) to
 * a canonical participantId. Email lookups search the Hivekeeper table only —
 * agents do not have email identities in v0.1.
 */
export async function resolveParticipantReference(
  input: string,
  runtime: CliRuntime,
): Promise<UUIDv7> {
  const ctx = getCliCallerContext(runtime);
  const ref = parseParticipantReference(input, ctx.hiveName);
  if (ref.kind === 'uuid') return ref.raw;
  const keeper = await runtime.participantsRepo.findHivekeeperByEmail(ctx.hiveId, ref.raw);
  if (!keeper) {
    throw new AuthError('PARTICIPANT_NOT_FOUND', { subCode: 'email_not_found' });
  }
  return keeper.id;
}

/**
 * Resolve `--operator-id` input to a UUIDv7. Accepted: UUID v7 OR Hivekeeper
 * email. The 'self' alias and agent-reference syntax produce
 * `CliError(OPERATOR_ID_INVALID)` because operators are always Hivekeepers
 * (per ADR-007).
 *
 * The downstream `buildOperatorActor` validates that the resolved UUID is an
 * active admin — this helper only translates the user-facing input form to
 * the canonical id.
 */
export async function resolveOperatorId(input: string, runtime: CliRuntime): Promise<UUIDv7> {
  const ctx = getCliCallerContext(runtime);
  const parsed = parseReference(input, ctx.hiveName);

  if (parsed === null) {
    throw new CliError('OPERATOR_ID_INVALID', {
      subCode: 'malformed_reference',
      message: `'${input}' is not a valid reference (expected UUID v7 or hivekeeper email)`,
    });
  }

  if (parsed.kind === 'uuid') return parsed.id;

  if (parsed.kind === 'hivekeeper-email') {
    const hk = await runtime.participantsRepo.findHivekeeperByEmail(ctx.hiveId, parsed.email);
    if (hk === null) {
      throw new AuthError('PARTICIPANT_NOT_FOUND', { subCode: 'operator_email_not_found' });
    }
    return hk.id;
  }

  // 'self' or 'agent-reference' — not applicable to --operator-id (operators
  // are always Hivekeepers; self is an MCP wire concept that has no CLI shell
  // analog).
  throw new CliError('OPERATOR_ID_INVALID', {
    subCode: 'kind_not_allowed',
    message: `--operator-id requires UUID v7 or hivekeeper email, got '${parsed.kind}'`,
  });
}

/**
 * Resolve an agent reference input to a canonical agent UUIDv7. Accepted forms:
 *   - UUID v7 (passes through without DB lookup; preserves the pre-PRY-040
 *     idempotent semantics of `repo.revokeAgent` for unknown UUIDs).
 *   - Agent reference `<name>@<owner-local>.<hiveName>` (per ADR-015 syntax,
 *     PRY-024 wire-side). Resolves owner via `findHivekeeperByEmailLocalPart`,
 *     then agent via `findAgentByName(hiveId, ownerId, name)`.
 *
 * Other parser kinds ('hivekeeper-email', 'self') are rejected with
 * `CliError(CONFIG_INVALID, kind_not_allowed)` because the agent revoke
 * positional only accepts an Agent identifier.
 *
 * Resolution failures (owner local-part not found, or agent name not found
 * under that owner) raise `AuthError(PARTICIPANT_NOT_FOUND)` so the existing
 * handler.ts mapping produces `EXIT_NOT_FOUND (3)` per ADR-020 § Decision
 * step 4.
 */
export async function resolveAgentReference(input: string, runtime: CliRuntime): Promise<UUIDv7> {
  const ctx = getCliCallerContext(runtime);
  const parsed = parseReference(input, ctx.hiveName);

  if (parsed === null) {
    throw new CliError('CONFIG_INVALID', {
      subCode: 'agent_ref_unparseable',
      message: `'${input}' is not a valid reference (expected UUID v7 or agent reference '<name>@<owner-local>.${ctx.hiveName}')`,
    });
  }

  if (parsed.kind === 'uuid') return parsed.id;

  if (parsed.kind === 'agent-reference') {
    const owner = await runtime.participantsRepo.findHivekeeperByEmailLocalPart(
      ctx.hiveId,
      parsed.ownerLocal,
    );
    if (owner === null) {
      throw new AuthError('PARTICIPANT_NOT_FOUND', { subCode: 'agent_owner_not_found' });
    }
    const agent = await runtime.participantsRepo.findAgentByName(
      ctx.hiveId,
      owner.id,
      parsed.agentName,
    );
    if (agent === null) {
      throw new AuthError('PARTICIPANT_NOT_FOUND', { subCode: 'agent_name_not_found' });
    }
    return agent.id;
  }

  // 'hivekeeper-email', 'self', or 'credential-active' — not applicable to
  // <agent-ref> (agents are not addressable by email; self has no CLI shell
  // analog; credential-active is the wrong target type for revoke).
  throw new CliError('CONFIG_INVALID', {
    subCode: 'kind_not_allowed',
    message: `<agent-ref> requires UUID v7 or agent reference '<name>@<owner-local>.${ctx.hiveName}', got '${parsed.kind}'`,
  });
}

/**
 * Resolve a `<jti-or-active-ref>` input to a canonical credential JTI. Accepted
 * forms (per ADR-020 § Decision step 4 + PRY-041):
 *   - UUID v7 (passes through without DB lookup; preserves the pre-PRY-041
 *     idempotent semantics of `revoker.revokeCredential` for unknown JTIs and
 *     defers existence checks to the domain layer where the credential row
 *     itself is read).
 *   - `<participant-ref>:latest` (kind `credential-active`). The inner
 *     `<participant-ref>` may be a UUID, hivekeeper email, or agent reference.
 *     Resolves the participant first, then looks up the active credential via
 *     `credentialsRepo.findActiveCredentialByParticipant`.
 *
 * Other parser kinds ('self', bare 'hivekeeper-email' without `:latest`, bare
 * 'agent-reference' without `:latest') are rejected with
 * `CliError(CONFIG_INVALID, kind_not_allowed)` — the credential rotate/revoke
 * positional only accepts a JTI or the explicit `:latest` alias.
 *
 * Resolution failures:
 *   - Inner participant resolves but has no active credential → `AuthError(
 *     PARTICIPANT_NOT_FOUND, no_active_credential)` so handler.ts maps to
 *     `EXIT_NOT_FOUND (3)` per ADR-020 § Decision step 4.
 *   - Inner email/agent ref does not resolve → `AuthError(PARTICIPANT_NOT_FOUND,
 *     <participant_owner_or_name>_not_found)` (same mapping path).
 *   - Reference unparseable → `CliError(CONFIG_INVALID, jti_or_ref_unparseable)`
 *     → `EXIT_USER_ERROR (1)`.
 */
export async function resolveCredentialRef(input: string, runtime: CliRuntime): Promise<UUIDv7> {
  const ctx = getCliCallerContext(runtime);
  const parsed = parseReference(input, ctx.hiveName);

  if (parsed === null) {
    throw new CliError('CONFIG_INVALID', {
      subCode: 'jti_or_ref_unparseable',
      message: `'${input}' is not a valid reference (expected UUID v7 JTI or '<participant-ref>:latest')`,
    });
  }

  if (parsed.kind === 'uuid') return parsed.id;

  if (parsed.kind === 'credential-active') {
    const participantId = await resolveParsedParticipant(parsed.participant, runtime, ctx);
    const credential = await runtime.credentialsRepo.findActiveCredentialByParticipant(
      ctx.hiveId,
      participantId,
      new Date(),
    );
    if (credential === null) {
      throw new AuthError('PARTICIPANT_NOT_FOUND', { subCode: 'no_active_credential' });
    }
    return credential.jti;
  }

  // 'self', 'hivekeeper-email' (without `:latest`), or 'agent-reference'
  // (without `:latest`) — not applicable.
  throw new CliError('CONFIG_INVALID', {
    subCode: 'kind_not_allowed',
    message: `<jti-or-active-ref> requires UUID v7 JTI or '<participant-ref>:latest', got '${parsed.kind}'`,
  });
}

/**
 * Resolve `--actor-id` / `--subject-id` input for `audit query` (PRY-042) to a
 * canonical participant UUIDv7. Both flags accept the same set of forms and
 * share this helper — `fieldName` only parameterises the error subCodes /
 * messages so failures identify which flag the operator typed wrong.
 *
 * Accepted forms:
 *   - UUID v7 (passes through without DB lookup; the audit_log is queried by
 *     id-equality, so an unknown UUID simply yields zero rows — same behavior
 *     as pre-PRY-042).
 *   - Hivekeeper email — resolved via `findHivekeeperByEmail`.
 *   - Agent reference `<name>@<owner-local>.<hiveName>` (per ADR-015) —
 *     resolved via `findHivekeeperByEmailLocalPart` + `findAgentByName`.
 *
 * Other parser kinds ('self', 'credential-active') are rejected with
 * `CliError(CONFIG_INVALID, kind_not_allowed)`: 'self' has no CLI shell analog
 * (no current participant context), and `<participant-ref>:latest` resolves to
 * a credential JTI which is never an audit `actor_id` / `subject_id` — the
 * audit_log records who/what was acted upon by participant id, not by
 * credential.
 *
 * Resolution failures map to `AuthError(PARTICIPANT_NOT_FOUND, audit_<flag>_*)`
 * so handler.ts produces `EXIT_NOT_FOUND (3)` per ADR-020 § Decision step 4.
 */
export async function resolveAuditParticipantReference(
  input: string,
  fieldName: 'actor-id' | 'subject-id',
  runtime: CliRuntime,
): Promise<UUIDv7> {
  const ctx = getCliCallerContext(runtime);
  const parsed = parseReference(input, ctx.hiveName);

  if (parsed === null) {
    throw new CliError('CONFIG_INVALID', {
      subCode: `${fieldName === 'actor-id' ? 'actor_id' : 'subject_id'}_unparseable`,
      message: `--${fieldName} '${input}' is not a valid reference (expected UUID v7, hivekeeper email, or agent reference '<name>@<owner-local>.${ctx.hiveName}')`,
    });
  }

  if (
    parsed.kind === 'uuid' ||
    parsed.kind === 'hivekeeper-email' ||
    parsed.kind === 'agent-reference'
  ) {
    return resolveParsedParticipant(parsed, runtime, ctx, fieldName);
  }

  // 'self' or 'credential-active' — not applicable to audit identifier flags.
  throw new CliError('CONFIG_INVALID', {
    subCode: 'kind_not_allowed',
    message: `--${fieldName} requires UUID v7, hivekeeper email, or agent reference, got '${parsed.kind}'`,
  });
}

/**
 * Internal helper: resolve a parsed participant reference to a canonical
 * UUIDv7. The type parameter (`Extract<ParsedReference, { kind: 'uuid' |
 * 'hivekeeper-email' | 'agent-reference' }>`) excludes `self` and
 * `credential-active` at the type level — callers that accept those kinds are
 * responsible for handling them upstream. Wraps the same lookup chain as
 * `resolveAgentReference` but kept separate so error subCodes can be
 * call-site-specific.
 *
 * `flow` discriminates the subCode prefix:
 *   - `'credential'` (default; PRY-041): `credential_owner_not_found` /
 *     `credential_agent_not_found`.
 *   - `'actor-id'` / `'subject-id'` (PRY-042): `audit_<flow>_email_not_found` /
 *     `audit_<flow>_owner_not_found` / `audit_<flow>_name_not_found`.
 */
async function resolveParsedParticipant(
  parsed: Extract<ParsedReference, { kind: 'uuid' | 'hivekeeper-email' | 'agent-reference' }>,
  runtime: CliRuntime,
  ctx: ReturnType<typeof getCliCallerContext>,
  flow: 'credential' | 'actor-id' | 'subject-id' = 'credential',
): Promise<UUIDv7> {
  if (parsed.kind === 'uuid') return parsed.id;

  const subCodePrefix =
    flow === 'credential' ? 'credential' : flow === 'actor-id' ? 'audit_actor' : 'audit_subject';

  if (parsed.kind === 'hivekeeper-email') {
    const hk = await runtime.participantsRepo.findHivekeeperByEmail(ctx.hiveId, parsed.email);
    if (hk === null) {
      throw new AuthError('PARTICIPANT_NOT_FOUND', {
        subCode:
          flow === 'credential' ? 'credential_owner_not_found' : `${subCodePrefix}_email_not_found`,
      });
    }
    return hk.id;
  }

  // parsed.kind === 'agent-reference'
  const owner = await runtime.participantsRepo.findHivekeeperByEmailLocalPart(
    ctx.hiveId,
    parsed.ownerLocal,
  );
  if (owner === null) {
    throw new AuthError('PARTICIPANT_NOT_FOUND', {
      subCode:
        flow === 'credential' ? 'credential_owner_not_found' : `${subCodePrefix}_owner_not_found`,
    });
  }
  // The audit-log resolver path (PRY-045) MUST resolve agents whose state is
  // `revoked` so `audit query --actor-id`/`--subject-id` keeps working after
  // the agent was revoked. Other flows keep using the default lookup which
  // rejects revoked agents at resolution time.
  const findAgent =
    flow === 'actor-id' || flow === 'subject-id'
      ? runtime.participantsRepo.findAgentByNameIncludingRevoked.bind(runtime.participantsRepo)
      : runtime.participantsRepo.findAgentByName.bind(runtime.participantsRepo);
  const agent = await findAgent(ctx.hiveId, owner.id, parsed.agentName);
  if (agent === null) {
    throw new AuthError('PARTICIPANT_NOT_FOUND', {
      subCode:
        flow === 'credential' ? 'credential_agent_not_found' : `${subCodePrefix}_name_not_found`,
    });
  }
  return agent.id;
}
