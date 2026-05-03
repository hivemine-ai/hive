import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { compact, expanded } from './banner.js';

// Detect ANSI SGR sequences via control char built from charCode (the
// `no-control-regex` ESLint rule flags raw ESC literals).
const ESC = String.fromCharCode(0x1b);
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`);

describe('banner.compact', () => {
  const previousLevel = chalk.level;
  beforeEach(() => {
    // Force NO_COLOR mode so the byte assertions are deterministic. Tests
    // that need to see ANSI explicitly bump the level up themselves.
    chalk.level = 0;
  });
  afterEach(() => {
    chalk.level = previousLevel;
  });

  it('renders 3 lines with the subtitle interpolated on line 3 (NO_COLOR plain text)', () => {
    const out = compact('snapshot 12s ago');
    const lines = out.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain('snapshot 12s ago');
  });

  it('matches the design system frame byte-for-byte in NO_COLOR mode', () => {
    // Per [[hivectl — Operator Experience]] § Banner contract — see the
    // 07c hivectl v3.html design reference. Banner is immutable; any
    // diff here means a spec amend was required.
    expect(compact('snapshot 12s ago')).toBe(
      [
        '    ⬢ ⬢ ⬢    hivectl  ·  v0.1.0  ·  apache-2.0',
        '  ⬢ ⬢ ⬢ ⬢ ⬢  open-source MCP server for collaborative AI agents',
        '    ⬢ ⬢ ⬢    snapshot 12s ago',
      ].join('\n'),
    );
  });

  it('preserves a pre-coloured subtitle (caller decides muted vs warn)', () => {
    chalk.level = 3;
    const subtitle = chalk.hex('#D8A53C')('snapshot 4m 12s ago — stale');
    const out = compact(subtitle);
    expect(out).toContain(subtitle);
    expect(ANSI_RE.test(out)).toBe(true);
  });

  it('emits ANSI sequences for the brand glyph cluster when colour is enabled', () => {
    chalk.level = 3;
    const out = compact('any');
    // The ⬢ glyphs must travel coloured (palette.honey).
    expect(ANSI_RE.test(out)).toBe(true);
    expect(out).toContain('⬢');
  });

  it('renders the version/license metadata on line 1', () => {
    const lines = compact('any').split('\n');
    expect(lines[0]).toContain('hivectl');
    expect(lines[0]).toContain('v0.1.0');
    expect(lines[0]).toContain('apache-2.0');
  });

  it('renders the tagline on line 2', () => {
    const lines = compact('any').split('\n');
    expect(lines[1]).toContain('open-source MCP server for collaborative AI agents');
  });
});

describe('banner.expanded', () => {
  it('throws — implementation lands in PRY-052 (Slice 5) per the cascade plan', () => {
    expect(() => expanded()).toThrow(/PRY-052/);
  });
});
