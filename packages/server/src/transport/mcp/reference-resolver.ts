import type { IdentityContext, UUIDv7 } from '#domain/auth/index.js';
import type { ParticipantsReadRepo } from '#domain/auth/participants/repository.js';
import { CellError } from '#domain/cells/index.js';

// UUID v7 regex per ADR-005 — accepted case-insensitively; output is normalised to lowercase.
// Version nibble must be 7; variant bits must be [89ab].
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Conservative subset of RFC 5321 local-part chars per ADR-015 — used for the
// agent-reference owner-local segment. Enough for the v0.1 OSS validation
// internal email shapes (alphanum + `.` + `_` + `-`).
const EMAIL_LOCAL_PART_RE = /^[A-Za-z0-9._-]+$/;

// Lenient single-@ email regex — at least one char before and after, no whitespace.
// Downstream domain validates the actual address.
const EMAIL_RE = /^[^@\s]+@[^@\s]+$/;

export type ParsedReference =
  | { kind: 'uuid'; id: UUIDv7 }
  | { kind: 'self' }
  | { kind: 'hivekeeper-email'; email: string }
  | { kind: 'agent-reference'; agentName: string; ownerLocal: string };

/**
 * Parses a human-readable participant reference into a structured form,
 * disambiguating Hivekeeper emails from agent references via the caller's
 * `hiveName` suffix (per ADR-015 — single-`@` canonical syntax).
 *
 * Grammar:
 *   (a) UUID v7 canonical                            → matched case-insensitively, lowercased.
 *   (b) alias `self`                                 → case-sensitive, lowercase only.
 *   (c) `<agent-name>@<owner-email-local>.<hive-name>` (single `@`, suffix matches caller's hive)
 *                                                    → kind: 'agent-reference'.
 *   (d) `<local>@<domain>`                           → kind: 'hivekeeper-email' (single `@`, no
 *                                                       suffix match OR ownerLocal candidate empty).
 *
 * Algorithm (8 steps — verbatim from ADR-015):
 *   1. UUID v7 → 'uuid'.
 *   2. literal 'self' → 'self'.
 *   3. count('@') != 1 → null.
 *   4. split [local, afterAt].
 *   5. hiveSuffix = '.' + hiveName.
 *   6. afterAt endsWith hiveSuffix AND ownerLocal != '' AND EMAIL_LOCAL_PART_RE
 *                                                    → 'agent-reference'.
 *   7. else if EMAIL_RE.test(input)                  → 'hivekeeper-email'.
 *   8. else                                          → null.
 *
 * Returns null if no format matches — caller throws INVALID_INPUT.
 */
export function parseReference(input: string, hiveName: string): ParsedReference | null {
  const s = input.trim();
  if (s.length === 0) return null;

  // Step 1: UUID v7
  if (UUID_V7_RE.test(s)) {
    return { kind: 'uuid', id: s.toLowerCase() };
  }

  // Step 2: 'self'
  if (s === 'self') {
    return { kind: 'self' };
  }

  // Step 3: count('@') exactly 1
  const atCount = (s.match(/@/g) ?? []).length;
  if (atCount !== 1) return null;

  // Step 4: split
  const firstAt = s.indexOf('@');
  const local = s.slice(0, firstAt);
  const afterAt = s.slice(firstAt + 1);

  // Step 5: hiveSuffix
  const hiveSuffix = '.' + hiveName;

  // Step 6: agent-reference attempt
  if (afterAt.endsWith(hiveSuffix)) {
    const ownerLocal = afterAt.slice(0, afterAt.length - hiveSuffix.length);
    if (ownerLocal !== '' && EMAIL_LOCAL_PART_RE.test(ownerLocal) && local !== '') {
      return { kind: 'agent-reference', agentName: local, ownerLocal };
    }
  }

  // Step 7: hivekeeper-email fallback
  if (EMAIL_RE.test(s)) {
    return { kind: 'hivekeeper-email', email: s };
  }

  // Step 8: nothing matched
  return null;
}

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
