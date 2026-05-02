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
    const result = parseReference('admin@example.com', 'cotalker');
    expect(result).toEqual<ParsedReference>({
      kind: 'hivekeeper-email',
      email: 'admin@example.com',
    });
  });

  it('returns hivekeeper-email when suffix matches but ownerLocal would be empty (afterAt == hiveSuffix)', () => {
    // input = 'admin@.cotalker' → afterAt = '.cotalker', hiveSuffix = '.cotalker',
    // ownerLocal = '' → step 6 fails, step 7 evaluates: EMAIL_RE accepts 'admin@.cotalker'
    // (lenient `[^@\s]+@[^@\s]+`), so this resolves as an email of last resort.
    const result = parseReference('admin@.cotalker', 'cotalker');
    expect(result?.kind).toBe('hivekeeper-email');
  });

  it('returns hivekeeper-email when domain happens to look like a longer suffix', () => {
    // hiveName = 'cotalker', input domain = 'cotalker.example.com'
    // hiveSuffix = '.cotalker' — afterAt 'cotalker.example.com' does NOT end with '.cotalker'
    const result = parseReference('admin@cotalker.example.com', 'cotalker');
    expect(result?.kind).toBe('hivekeeper-email');
  });

  // --- empty / whitespace ---

  it('returns null for empty string', () => {
    expect(parseReference('', 'test-hive')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(parseReference('   ', 'test-hive')).toBeNull();
  });
});
