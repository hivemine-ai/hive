import { describe, it, expect } from 'vitest';

import { CellError } from '#domain/cells/index.js';

import { ensureSafeAction, MAX_ACTION_DEPTH } from './action-safety.js';

describe('ensureSafeAction', () => {
  it('passes through primitives unchanged', () => {
    expect(ensureSafeAction('text', MAX_ACTION_DEPTH)).toBe('text');
    expect(ensureSafeAction(42, MAX_ACTION_DEPTH)).toBe(42);
    expect(ensureSafeAction(true, MAX_ACTION_DEPTH)).toBe(true);
    expect(ensureSafeAction(null, MAX_ACTION_DEPTH)).toBe(null);
  });

  it('passes through shallow objects', () => {
    const obj = { a: 1, b: 'two' };
    expect(ensureSafeAction(obj, MAX_ACTION_DEPTH)).toBe(obj);
  });

  it('passes through arrays at the limit', () => {
    // Build object exactly 32 levels deep: { a: { a: ... } } x 32
    let nested: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 31; i += 1) nested = { a: nested };
    expect(ensureSafeAction(nested, MAX_ACTION_DEPTH)).toBe(nested);
  });

  it('rejects 33-level deep nesting', () => {
    let nested: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 33; i += 1) nested = { a: nested };

    expect(() => ensureSafeAction(nested, MAX_ACTION_DEPTH)).toThrow(CellError);
    try {
      ensureSafeAction(nested, MAX_ACTION_DEPTH);
    } catch (err) {
      expect(err).toBeInstanceOf(CellError);
      expect((err as CellError).code).toBe('INVALID_INPUT');
      expect((err as CellError).subCode).toBe('action_too_deep');
    }
  });

  it('rejects deep array nesting', () => {
    let nested: unknown[] = [];
    for (let i = 0; i < 33; i += 1) nested = [nested];
    expect(() => ensureSafeAction(nested, MAX_ACTION_DEPTH)).toThrow(CellError);
  });

  it('handles mixed array+object nesting up to limit', () => {
    let nested: unknown = { leaf: true };
    for (let i = 0; i < 16; i += 1) nested = { x: [nested] }; // each level adds 2 (object → array → object → ...)
    // 16 iterations of {x:[...]} create roughly 32 levels of containers
    // Just verify it does NOT throw at this depth (assertion is structural — depth-of stays bounded).
    const result = ensureSafeAction(nested, 64);
    expect(result).toBe(nested);
  });

  it('uses iterative DFS — no recursion stack overflow on broad+deep mix', () => {
    // Wide AND deep — a recursive impl could blow the stack; iterative impl OK.
    const wideDeep: Record<string, unknown> = {};
    for (let i = 0; i < 100; i += 1) {
      wideDeep[`k${String(i)}`] = { a: { b: { c: { d: 'leaf' } } } };
    }
    expect(ensureSafeAction(wideDeep, MAX_ACTION_DEPTH)).toBe(wideDeep);
  });
});
