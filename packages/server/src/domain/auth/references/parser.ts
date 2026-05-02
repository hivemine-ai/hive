// Pure participant reference parser — single source of truth shared between
// the MCP wire (transport/mcp/reference-resolver.ts) and the CLI
// (packages/cli/src/input/parse-reference.ts).
//
// Public API per ADR-020 — extracted from transport/mcp/reference-resolver.ts
// so both surfaces (MCP wire + hivectl) parse references identically. The
// resolver (impure, repo-aware) remains in transport/mcp/.

import type { UUIDv7 } from '../types.js';

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
 * Returns null if no format matches — callers map to their own error code
 * (CellError on the MCP side, CliError on the hivectl side).
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
