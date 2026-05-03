import { describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';

import { parseReference, type ParsedReference } from './parser.js';

// ---------------------------------------------------------------------------
// parseReference — pure parser, takes hiveName for suffix disambiguation.
//
// Per ADR-015 § Decision (8-step algorithm):
//   1. UUID v7      → kind: 'uuid'
//   2. 'self'       → kind: 'self'
//   3. count('@') != 1 → null
//   4. split [local, afterAt]
//   5. hiveSuffix = '.' + hiveName
//   6. afterAt endsWith hiveSuffix AND ownerLocal != '' AND EMAIL_LOCAL_PART_RE
//                                                  → kind: 'agent-reference'
//   7. else if EMAIL_RE.test(input) → kind: 'hivekeeper-email'
//   8. else                          → null
//
// Test split per ADR-020 — these tests previously lived in
// transport/mcp/reference-resolver.test.ts. The resolver tests
// (impure, repo-dependent) remain in that file.
// ---------------------------------------------------------------------------

describe('parseReference', () => {
  // --- UUID v7 ---

  it('returns uuid kind for lowercase UUID v7', () => {
    const id = uuidv7();
    expect(parseReference(id, 'test-hive')).toEqual<ParsedReference>({ kind: 'uuid', id });
  });

  it('accepts uppercase UUID v7 and normalises output to lowercase', () => {
    const id = uuidv7();
    const result = parseReference(id.toUpperCase(), 'test-hive');
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('uuid');
    if (result!.kind === 'uuid') {
      expect(result!.id).toBe(id.toLowerCase());
    }
  });

  it('returns null for UUID v4 (version bit 4, not v7)', () => {
    expect(parseReference('01234567-89ab-4def-89ab-0123456789ab', 'test-hive')).toBeNull();
  });

  // --- self alias ---

  it('returns self kind for literal "self"', () => {
    expect(parseReference('self', 'test-hive')).toEqual<ParsedReference>({ kind: 'self' });
  });

  it('returns null for "Self" (case-sensitive — only lowercase)', () => {
    expect(parseReference('Self', 'test-hive')).toBeNull();
  });

  it('trims surrounding whitespace before parsing: "  self  " resolves to self kind', () => {
    expect(parseReference('  self  ', 'test-hive')).toEqual<ParsedReference>({ kind: 'self' });
  });

  // --- count('@') != 1 ---

  it('returns null when count(@) == 0 (and not self/uuid)', () => {
    expect(parseReference('not-a-valid-ref', 'test-hive')).toBeNull();
  });

  it('returns null when count(@) > 1 (e.g. legacy double-@ format is rejected)', () => {
    expect(parseReference('agent@owner@example.com.test-hive', 'test-hive')).toBeNull();
  });

  it('returns null when count(@) > 1 — three @s', () => {
    expect(parseReference('a@b@c@d.test-hive', 'test-hive')).toBeNull();
  });

  // --- agent-reference (single @, suffix matches `.<hiveName>`) ---

  it('returns agent-reference for `<agent>@<owner-local>.<hive-name>`', () => {
    const result = parseReference('worker-a@admin.test-hive', 'test-hive');
    expect(result).toEqual<ParsedReference>({
      kind: 'agent-reference',
      agentName: 'worker-a',
      ownerLocal: 'admin',
    });
  });

  it('returns agent-reference when owner-local contains dots (john.doe)', () => {
    const result = parseReference('worker@john.doe.test-hive', 'test-hive');
    expect(result).toEqual<ParsedReference>({
      kind: 'agent-reference',
      agentName: 'worker',
      ownerLocal: 'john.doe',
    });
  });

  it('returns agent-reference when owner-local has dashes/underscores allowed by EMAIL_LOCAL_PART_RE', () => {
    const result = parseReference('w@first-last_x.test-hive', 'test-hive');
    expect(result).toEqual<ParsedReference>({
      kind: 'agent-reference',
      agentName: 'w',
      ownerLocal: 'first-last_x',
    });
  });

  it('returns null when ownerLocal candidate fails EMAIL_LOCAL_PART_RE (whitespace inside)', () => {
    // After suffix strip, ownerLocal = 'admin x' — fails the regex.
    // count('@') == 1, suffix matches, but the pre-suffix portion is invalid →
    // step 6 fails, step 7 also fails (input has space → not email-shaped) → null.
    expect(parseReference('worker@admin x.test-hive', 'test-hive')).toBeNull();
  });

  it('agent-reference takes precedence over hivekeeper-email when suffix matches', () => {
    // Without the suffix check, `worker@admin.test-hive` could also be parsed
    // as a hivekeeper email. ADR-015 step 6 happens before step 7.
    const result = parseReference('worker@admin.test-hive', 'test-hive');
    expect(result?.kind).toBe('agent-reference');
  });

  // --- hivekeeper-email (single @, suffix does NOT match) ---

  it('returns hivekeeper-email when suffix does NOT match the caller hiveName', () => {
    const result = parseReference('admin@example.com', 'test-hive');
    expect(result).toEqual<ParsedReference>({
      kind: 'hivekeeper-email',
      email: 'admin@example.com',
    });
  });

  it('returns hivekeeper-email when suffix matches but ownerLocal would be empty (afterAt == hiveSuffix)', () => {
    // input = 'admin@.test-hive' → afterAt = '.test-hive', hiveSuffix = '.test-hive',
    // ownerLocal = '' → step 6 fails, step 7 evaluates: EMAIL_RE accepts 'admin@.test-hive'
    // (lenient `[^@\s]+@[^@\s]+`), so this resolves as an email of last resort.
    const result = parseReference('admin@.test-hive', 'test-hive');
    expect(result?.kind).toBe('hivekeeper-email');
  });

  it('returns hivekeeper-email when domain happens to look like a longer suffix', () => {
    // hiveName = 'test-hive', input domain = 'test-hive.example.com'
    // hiveSuffix = '.test-hive' — afterAt 'test-hive.example.com' does NOT end with '.test-hive'
    const result = parseReference('admin@test-hive.example.com', 'test-hive');
    expect(result?.kind).toBe('hivekeeper-email');
  });

  // --- empty / whitespace ---

  it('returns null for empty string', () => {
    expect(parseReference('', 'test-hive')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(parseReference('   ', 'test-hive')).toBeNull();
  });

  // --- credential-active alias (`<participant-ref>:latest`, ADR-020 Q3=3B) ---

  it('returns credential-active wrapping uuid for `<uuid>:latest`', () => {
    const id = uuidv7();
    const result = parseReference(`${id}:latest`, 'test-hive');
    expect(result).toEqual<ParsedReference>({
      kind: 'credential-active',
      participant: { kind: 'uuid', id },
    });
  });

  it('returns credential-active wrapping hivekeeper-email for `<email>:latest`', () => {
    const result = parseReference('admin@example.com:latest', 'test-hive');
    expect(result).toEqual<ParsedReference>({
      kind: 'credential-active',
      participant: { kind: 'hivekeeper-email', email: 'admin@example.com' },
    });
  });

  it('returns credential-active wrapping agent-reference for `<agent>@<owner-local>.<hive>:latest`', () => {
    const result = parseReference('worker-a@admin.test-hive:latest', 'test-hive');
    expect(result).toEqual<ParsedReference>({
      kind: 'credential-active',
      participant: {
        kind: 'agent-reference',
        agentName: 'worker-a',
        ownerLocal: 'admin',
      },
    });
  });

  it('returns null for bare `:latest` (no prefix)', () => {
    expect(parseReference(':latest', 'test-hive')).toBeNull();
  });

  it('parses `<email>:` (trailing colon, no `latest`) as a lenient hivekeeper-email — resolver layer rejects via kind_not_allowed', () => {
    // 'admin@example.com:' is not :latest-suffixed, so step 0 skips. count('@')
    // == 1, EMAIL_RE is lenient (`^[^@\s]+@[^@\s]+$`) — the trailing ':' has
    // neither '@' nor whitespace, so the entire string passes as a
    // hivekeeper-email at the parser layer. The resolver/handler is responsible
    // for rejecting an unsupported kind for the `<jti-or-active-ref>` positional
    // (`CliError(kind_not_allowed)` per ADR-020 § Decision step 4). The parser
    // is intentionally lenient and stops at syntactic disambiguation.
    const result = parseReference('admin@example.com:', 'test-hive');
    expect(result).toEqual<ParsedReference>({
      kind: 'hivekeeper-email',
      email: 'admin@example.com:',
    });
  });

  it('returns null for `:latest:latest` (double suffix — inner parses to credential-active, not allowed)', () => {
    // Outer step 0 strips the trailing ':latest'; the prefix ':latest' has step 0
    // strip its own trailing ':latest' → empty prefix → null. So inner is null →
    // outer returns null too.
    const id = uuidv7();
    expect(parseReference(`${id}:latest:latest`, 'test-hive')).toBeNull();
  });

  it('returns null for `self:latest` (self is not in ParsedParticipantReference)', () => {
    // Inner parses to {kind: 'self'} which is not allowed in the wrapper.
    expect(parseReference('self:latest', 'test-hive')).toBeNull();
  });

  it('trims surrounding whitespace before parsing the `:latest` alias', () => {
    const id = uuidv7();
    const result = parseReference(`  ${id}:latest  `, 'test-hive');
    expect(result?.kind).toBe('credential-active');
  });
});
