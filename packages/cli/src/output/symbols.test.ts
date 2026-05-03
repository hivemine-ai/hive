import { describe, expect, it } from 'vitest';

import { sym } from './symbols.js';

describe('sym (glyph vocabulary)', () => {
  it('exposes every documented glyph', () => {
    const expected = [
      'prompt',
      'hex',
      'dot',
      'dotEmpty',
      'check',
      'cross',
      'warn',
      'rule',
    ] as const;
    for (const key of expected) {
      expect(typeof sym[key]).toBe('string');
    }
  });

  it('every glyph is a single user-perceived character', () => {
    const values: string[] = Object.values(sym);
    for (const value of values) {
      // Iterator splits by code points, which is sufficient — the chosen
      // glyphs are all from the BMP (no surrogate pairs, no ZWJ sequences).
      const codePoints = [...value];
      expect(codePoints).toHaveLength(1);
    }
  });

  it('matches the canonical handoff values', () => {
    expect(sym.prompt).toBe('⬡');
    expect(sym.hex).toBe('⬢');
    expect(sym.dot).toBe('●');
    expect(sym.dotEmpty).toBe('○');
    expect(sym.check).toBe('✓');
    expect(sym.cross).toBe('✗');
    expect(sym.warn).toBe('⚠');
    expect(sym.rule).toBe('─');
  });
});
