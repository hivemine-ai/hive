import type { IdentityContext, UUIDv7 } from '#domain/auth/index.js';
import type { CredentialsReadRepo } from '#domain/auth/credentials/repository.js';
import type { ParticipantsReadRepo } from '#domain/auth/participants/repository.js';
import { parseReference, type ParsedReference } from '#domain/auth/references/parser.js';
import { CellError } from '#domain/cells/index.js';

// `parseReference` + `ParsedReference` were extracted to `domain/auth/references/parser.js`
// per ADR-020 — single source of truth shared with the CLI. The resolver below
// remains MCP-specific because of its dependency on `IdentityContext`.

export type { ParsedReference };
export { parseReference };

export interface ReferenceResolverDeps {
  participantsRepo: ParticipantsReadRepo;
  /**
   * Optional. Required only by `resolveCredentialActiveReference` (PRY-041).
   * The MCP wire today has no tool that consumes the `<participant-ref>:latest`
   * alias (rotation/revocation are CLI-only operations), so factories that
   * don't wire credentialsRepo will throw at resolution time if a consumer
   * ever calls the credential-active resolver. The CLI side does its own
   * resolution via `parse-reference.ts`.
   */
  credentialsRepo?: CredentialsReadRepo;
  now?: () => Date;
}

export interface ReferenceResolver {
  /**
   * Resolves a human-readable participant reference to a UUID v7 opaque id.
   *
   * Accepted formats (per ADR-015):
   *   (a) UUID v7 canonical — passes through without DB lookup.
   *   (b) Hivekeeper email — `<local>@<domain>` (single `@`, domain does NOT end in `.<hiveName>`).
   *   (c) Agent reference — `<agent>@<owner-local>.<hiveName>` (single `@`, suffix matches caller's hive).
   *   (d) Alias `self` — returns callerContext.participantId.
   *
   * The `<participant-ref>:latest` alias (kind `credential-active`, ADR-020
   * Q3=3B) is **rejected** here with `INVALID_INPUT` — it returns a credential
   * JTI, not a participant id, so silently widening the return semantics would
   * surprise the wire callers. Use `resolveCredentialActiveReference` for that
   * kind.
   *
   * Errors:
   *   - Format unparseable → throws CellError('INVALID_INPUT', { subCode: 'reference_unparseable' }).
   *   - Email/agent reference parses but participant not found → throws
   *     CellError('RECIPIENT_UNREACHABLE', { subCode: 'reference_unresolved' }) — uniform privacy.
   */
  resolveParticipantReference(input: string, callerContext: IdentityContext): Promise<UUIDv7>;

  /**
   * Resolves a `<participant-ref>:latest` alias to the JTI of the participant's
   * currently-active credential (per ADR-020 Q3=3B). The inner participant
   * reference is parsed and resolved using the same algorithm as
   * `resolveParticipantReference`; the resulting UUID is then looked up in the
   * credentials repo (defense-in-depth ordering by `issued_at DESC`).
   *
   * The MCP wire has no consumer today; the function exists so that any future
   * MCP tool that needs to operate on a credential by friendly reference can
   * reuse the parser + resolver stack. CLI consumption goes through
   * `cli/src/input/parse-reference.ts::resolveCredentialRef` which mirrors this
   * function but emits `CliError`/`AuthError` instead of `CellError`.
   *
   * Errors:
   *   - Input does not parse as `credential-active` → INVALID_INPUT.
   *   - Inner participant resolves but has no active credential → RECIPIENT_UNREACHABLE
   *     with subCode `no_active_credential`.
   *   - `credentialsRepo` was not wired into the resolver factory → INTERNAL.
   */
  resolveCredentialActiveReference(input: string, callerContext: IdentityContext): Promise<UUIDv7>;
}

export function createReferenceResolver(deps: ReferenceResolverDeps): ReferenceResolver {
  const { participantsRepo } = deps;
  const credentialsRepo = deps.credentialsRepo;
  const now = deps.now ?? (() => new Date());

  async function resolveParsedToParticipantId(
    parsed: ParsedReference,
    callerContext: IdentityContext,
  ): Promise<UUIDv7> {
    if (parsed.kind === 'uuid') return parsed.id;
    if (parsed.kind === 'self') return callerContext.participantId;
    if (parsed.kind === 'hivekeeper-email') {
      const hk = await participantsRepo.findHivekeeperByEmail(callerContext.hiveId, parsed.email);
      if (hk === null) {
        throw new CellError('RECIPIENT_UNREACHABLE', { subCode: 'reference_unresolved' });
      }
      return hk.id;
    }
    if (parsed.kind === 'agent-reference') {
      const owner = await participantsRepo.findHivekeeperByEmailLocalPart(
        callerContext.hiveId,
        parsed.ownerLocal,
      );
      if (owner === null) {
        throw new CellError('RECIPIENT_UNREACHABLE', { subCode: 'reference_unresolved' });
      }
      const agent = await participantsRepo.findAgentByName(
        callerContext.hiveId,
        owner.id,
        parsed.agentName,
      );
      if (agent === null) {
        throw new CellError('RECIPIENT_UNREACHABLE', { subCode: 'reference_unresolved' });
      }
      return agent.id;
    }
    // `credential-active` is the only remaining kind; participant resolvers
    // never accept it.
    throw new CellError('INVALID_INPUT', { subCode: 'kind_not_allowed' });
  }

  return {
    async resolveParticipantReference(input, callerContext) {
      const parsed = parseReference(input, callerContext.hiveName);
      if (parsed === null) {
        throw new CellError('INVALID_INPUT', { subCode: 'reference_unparseable' });
      }
      return resolveParsedToParticipantId(parsed, callerContext);
    },

    async resolveCredentialActiveReference(input, callerContext) {
      if (!credentialsRepo) {
        throw new CellError('INTERNAL_INCONSISTENCY', {
          subCode: 'credentials_repo_not_wired',
        });
      }
      const parsed = parseReference(input, callerContext.hiveName);
      if (parsed === null || parsed.kind !== 'credential-active') {
        throw new CellError('INVALID_INPUT', { subCode: 'reference_unparseable' });
      }
      const participantId = await resolveParsedToParticipantId(parsed.participant, callerContext);
      const credential = await credentialsRepo.findActiveCredentialByParticipant(
        callerContext.hiveId,
        participantId,
        now(),
      );
      if (credential === null) {
        throw new CellError('RECIPIENT_UNREACHABLE', {
          subCode: 'no_active_credential',
        });
      }
      return credential.jti;
    },
  };
}
