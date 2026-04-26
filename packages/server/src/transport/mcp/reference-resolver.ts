import type { IdentityContext, UUIDv7 } from '#domain/auth/index.js';
import type { ParticipantsReadRepo } from '#domain/auth/participants/repository.js';
import { CellError } from '#domain/cells/index.js';

// UUID v7 regex per ADR-005 — accepted case-insensitively; output is normalised to lowercase.
// Version nibble must be 7; variant bits must be [89ab].
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Simple email disambiguator: at least one char before @, at least one char after.
// Deliberately lenient — downstream domain validates the actual address.
const EMAIL_RE = /^[^@\s]+@[^@\s]+$/;

export type ParsedReference =
  | { kind: 'uuid'; id: UUIDv7 }
  | { kind: 'self' }
  | { kind: 'hivekeeper-email'; email: string }
  | { kind: 'agent-reference'; agentName: string; ownerEmail: string; hiveName: string };

/**
 * Parses a human-readable participant reference string into a structured form.
 *
 * Grammar (per tech spec § reference-resolver.ts and PRY-006 hito 5 decision):
 *   (a) UUID v7 canonical  — matched case-insensitively, normalised to lowercase.
 *   (b) alias `self`       — case-sensitive, lowercase only.
 *   (c) agent-reference    — exactly 2 `@` separators:
 *         `<agent-name>@<owner-email-local>@<owner-email-domain>.<hive-name>`
 *         Split: first `@` → agentName; last `.` after the second `@` → hiveName.
 *   (d) hivekeeper-email   — exactly 1 `@` separator: `<local>@<domain>`.
 *
 * Returns null if no format matches — caller throws INVALID_INPUT.
 */
export function parseReference(input: string): ParsedReference | null {
  const s = input.trim();
  if (s.length === 0) return null;

  if (UUID_V7_RE.test(s)) {
    return { kind: 'uuid', id: s.toLowerCase() };
  }

  if (s === 'self') {
    return { kind: 'self' };
  }

  const atCount = (s.match(/@/g) ?? []).length;

  // Exactly 2 `@` → agent-reference grammar.
  // The owner email already contains one `@`; the leading one separates agentName.
  if (atCount === 2) {
    const firstAt = s.indexOf('@');
    const agentName = s.slice(0, firstAt);
    const rest = s.slice(firstAt + 1); // `<owner-email-local>@<owner-email-domain>.<hive-name>`
    const lastDot = rest.lastIndexOf('.');
    if (agentName.length === 0 || lastDot === -1 || lastDot === rest.length - 1) return null;
    const ownerEmail = rest.slice(0, lastDot);
    const hiveName = rest.slice(lastDot + 1);
    if (!EMAIL_RE.test(ownerEmail) || hiveName.length === 0) return null;
    return { kind: 'agent-reference', agentName, ownerEmail, hiveName };
  }

  // Exactly 1 `@` → hivekeeper-email.
  if (atCount === 1 && EMAIL_RE.test(s)) {
    return { kind: 'hivekeeper-email', email: s };
  }

  return null;
}

export interface ReferenceResolverDeps {
  participantsRepo: ParticipantsReadRepo;
}

export interface ReferenceResolver {
  /**
   * Resolves a human-readable participant reference to a UUID v7 opaque id.
   *
   * Accepted formats:
   *   (a) UUID v7 canonical — passes through without DB lookup.
   *   (b) Hivekeeper email — `<local>@<domain>` (single @, NO `.<hive>` suffix).
   *   (c) Agent reference — `<agent-name>@<owner-email-local>@<owner-email-domain>.<hive-name>` (double @).
   *   (d) Alias `self` — returns callerContext.participantId.
   *
   * Errors:
   *   - Format unparseable → throws CellError('INVALID_INPUT', { subCode: 'reference_unparseable' }).
   *   - Email/agent reference parses but participant not found → throws
   *     CellError('RECIPIENT_UNREACHABLE', { subCode: 'reference_unresolved' }).
   */
  resolveParticipantReference(input: string, callerContext: IdentityContext): Promise<UUIDv7>;
}

export function createReferenceResolver(deps: ReferenceResolverDeps): ReferenceResolver {
  const { participantsRepo } = deps;

  return {
    async resolveParticipantReference(input, callerContext) {
      const parsed = parseReference(input);

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

      // parsed.kind === 'agent-reference'
      const hive = await participantsRepo.findHiveById(callerContext.hiveId);
      if (hive === null || hive.name !== parsed.hiveName) {
        throw new CellError('RECIPIENT_UNREACHABLE', { subCode: 'reference_unresolved' });
      }

      const owner = await participantsRepo.findHivekeeperByEmail(
        callerContext.hiveId,
        parsed.ownerEmail,
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
