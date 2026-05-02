import type { IdentityContext, UUIDv7 } from '#domain/auth/index.js';
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
   * Errors:
   *   - Format unparseable → throws CellError('INVALID_INPUT', { subCode: 'reference_unparseable' }).
   *   - Email/agent reference parses but participant not found → throws
   *     CellError('RECIPIENT_UNREACHABLE', { subCode: 'reference_unresolved' }) — uniform privacy.
   */
  resolveParticipantReference(input: string, callerContext: IdentityContext): Promise<UUIDv7>;
}

export function createReferenceResolver(deps: ReferenceResolverDeps): ReferenceResolver {
  const { participantsRepo } = deps;

  return {
    async resolveParticipantReference(input, callerContext) {
      const parsed = parseReference(input, callerContext.hiveName);

      if (parsed === null) {
        throw new CellError('INVALID_INPUT', { subCode: 'reference_unparseable' });
      }

      if (parsed.kind === 'uuid') {
        return parsed.id;
      }

      if (parsed.kind === 'self') {
        return callerContext.participantId;
      }

      if (parsed.kind === 'hivekeeper-email') {
        const hk = await participantsRepo.findHivekeeperByEmail(callerContext.hiveId, parsed.email);
        if (hk === null) {
          throw new CellError('RECIPIENT_UNREACHABLE', { subCode: 'reference_unresolved' });
        }
        return hk.id;
      }

      // parsed.kind === 'agent-reference' — the suffix check at parse time
      // guarantees the ref belongs to the caller's hive, so we can skip the
      // hive lookup that the previous double-`@` implementation needed.
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
    },
  };
}
