import { HIVE_VERSION } from '@hive/shared';
import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { compact, expanded } from './banner.js';

const VLABEL = `v${HIVE_VERSION}`;

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
        `    ⬢ ⬢ ⬢    hivectl  ·  ${VLABEL}  ·  apache-2.0`,
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
    expect(lines[0]).toContain(VLABEL);
    expect(lines[0]).toContain('apache-2.0');
  });

  it('renders the tagline on line 2', () => {
    const lines = compact('any').split('\n');
    expect(lines[1]).toContain('open-source MCP server for collaborative AI agents');
  });
});

describe('banner.expanded', () => {
  const previousLevel = chalk.level;
  beforeEach(() => {
    chalk.level = 0;
  });
  afterEach(() => {
    chalk.level = previousLevel;
  });

  it('renders 5 lines (NO_COLOR plain text)', () => {
    const lines = expanded().split('\n');
    expect(lines).toHaveLength(5);
  });

  it('matches the design system frame byte-for-byte in NO_COLOR mode', () => {
    // Per [[hivectl — Operator Experience]] § Ceremonial del init — see
    // the 07c hivectl v3.html design reference. Banner is immutable;
    // any diff here means a spec amend was required.
    expect(expanded()).toBe(
      [
        '       ⬢ ⬢ ⬢ ⬢',
        `     ⬢ ⬢ ⬢ ⬢ ⬢ ⬢      hivectl   ·   ${VLABEL}`,
        '   ⬢ ⬢ ⬢ ⬢ ⬢ ⬢ ⬢ ⬢',
        '     ⬢ ⬢ ⬢ ⬢ ⬢ ⬢      bootstrapping a fresh Hive',
        '       ⬢ ⬢ ⬢ ⬢        apache-2.0  ·  hivemine-ai/hive',
      ].join('\n'),
    );
  });

  it('emits ANSI sequences for the brand glyph cluster when colour is enabled', () => {
    chalk.level = 3;
    const out = expanded();
    expect(ANSI_RE.test(out)).toBe(true);
    expect(out).toContain('⬢');
  });

  it('renders the version metadata on line 2', () => {
    const lines = expanded().split('\n');
    expect(lines[1]).toContain('hivectl');
    expect(lines[1]).toContain(VLABEL);
  });

  it('renders the bootstrapping subtitle on line 4', () => {
    const lines = expanded().split('\n');
    expect(lines[3]).toContain('bootstrapping a fresh Hive');
  });

  it('renders the licence + repo footer on line 5', () => {
    const lines = expanded().split('\n');
    expect(lines[4]).toContain('apache-2.0');
    expect(lines[4]).toContain('hivemine-ai/hive');
  });
});
