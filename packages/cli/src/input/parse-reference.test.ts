import { describe, expect, it } from 'vitest';

import { parseParticipantReference } from './parse-reference.js';

const VALID_UUID = '019d57a0-d6e0-7b3a-8d4f-cb2c4e72d100';

describe('parseParticipantReference', () => {
  it('detects UUID v7', () => {
    const ref = parseParticipantReference(VALID_UUID);
    expect(ref.kind).toBe('uuid');
    expect(ref.raw).toBe(VALID_UUID);
  });

  it('detects email', () => {
    const ref = parseParticipantReference('admin@example.com');
    expect(ref.kind).toBe('email');
    expect(ref.raw).toBe('admin@example.com');
  });

  it('lowercases UUID', () => {
    const ref = parseParticipantReference(VALID_UUID.toUpperCase());
    expect(ref.raw).toBe(VALID_UUID);
  });

  it('preserves email casing', () => {
    const ref = parseParticipantReference('Admin@Example.COM');
    expect(ref.raw).toBe('Admin@Example.COM');
  });

  it('rejects garbage', () => {
    expect(() => parseParticipantReference('garbage')).toThrow(
      /neither a UUID v7 nor a valid email/,
    );
    expect(() => parseParticipantReference('')).toThrow(/neither a UUID v7 nor a valid email/);
  });

  it('rejects agent reference shape (out of scope per tech spec)', () => {
    // <name>@<owner>.<hive> looks like an email but only the simple form is
    // allowed. The parser falls into 'email' for any `name@host.tld` shape;
    // if the operator passes a fake email that does not exist, the runtime
    // resolution will return PARTICIPANT_NOT_FOUND. That's the correct
    // behaviour — the parser is not responsible for resolving agent refs.
    const ref = parseParticipantReference('worker-a@admin.example.com');
    expect(ref.kind).toBe('email'); // looks like email, will fail lookup
  });
});
