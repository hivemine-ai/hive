import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { c, initColorMode, palette } from './colors.js';

// Detect ANSI SGR sequences (CSI ... m). Built via String.fromCharCode
// so the source file does not contain the raw control char (which the
// `no-control-regex` ESLint rule flags as suspicious).
const ESC = String.fromCharCode(0x1b);
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`);

describe('palette', () => {
  it('exposes the documented brand, neutral, and semantic hex tokens', () => {
    expect(palette.honey).toBe('#E8A02C');
    expect(palette.honeyDim).toBe('#9C6E1E');
    expect(palette.text).toBe('#E8E4DA');
    expect(palette.muted).toBe('#9A958A');
    expect(palette.subtle).toBe('#6E6A60');
    expect(palette.ok).toBe('#5FA86B');
    expect(palette.warn).toBe('#D8A53C');
    expect(palette.err).toBe('#C8553D');
    expect(palette.info).toBe('#4F8FB3');
  });

  it('hex values are valid 6-digit RGB strings', () => {
    for (const value of Object.values(palette)) {
      expect(value).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
});

describe('c (semantic helpers)', () => {
  const previousLevel = chalk.level;
  beforeEach(() => {
    // Force a coloured renderer for the assertions that expect ANSI.
    chalk.level = 3;
  });
  afterEach(() => {
    chalk.level = previousLevel;
  });

  it('exposes every documented helper as a function', () => {
    const expected = [
      'prompt',
      'brand',
      'cmd',
      'flag',
      'arg',
      'str',
      'num',
      'muted',
      'ok',
      'warn',
      'err',
      'info',
      'head',
      'levelChip',
    ] as const;
    for (const key of expected) {
      expect(typeof c[key]).toBe('function');
    }
  });

  it('emits ANSI sequences when chalk is enabled', () => {
    const out = c.brand('hivectl');
    expect(out).toContain('hivectl');
    expect(ANSI_RE.test(out)).toBe(true);
  });

  it('c.num accepts string or number', () => {
    expect(c.num('42')).toContain('42');
    expect(c.num(42)).toContain('42');
  });

  it('levelChip routes by trimmed level token', () => {
    const info = c.levelChip('INFO');
    const debug = c.levelChip('DEBUG');
    const warn = c.levelChip('WARN ');
    const error = c.levelChip('ERROR');
    expect(info).toContain('INFO');
    expect(debug).toContain('DEBUG');
    expect(warn).toContain('WARN ');
    expect(error).toContain('ERROR');
    // Different colour codes for different levels.
    expect(error).not.toBe(info);
    expect(warn).not.toBe(info);
    expect(debug).not.toBe(info);
  });
});

describe('initColorMode', () => {
  const previousLevel = chalk.level;
  afterEach(() => {
    chalk.level = previousLevel;
  });

  it('disables colour when NO_COLOR env is set (non-empty)', () => {
    chalk.level = 3;
    initColorMode({ argv: ['node', 'hivectl'], env: { NO_COLOR: '1' } });
    expect(chalk.level).toBe(0);
    expect(c.brand('hivectl')).toBe('hivectl');
  });

  it('treats empty NO_COLOR as unset (per https://no-color.org)', () => {
    chalk.level = 3;
    initColorMode({ argv: ['node', 'hivectl'], env: { NO_COLOR: '' } });
    expect(chalk.level).toBe(3);
  });

  it('disables colour when --no-color flag is present in argv', () => {
    chalk.level = 3;
    initColorMode({ argv: ['node', 'hivectl', '--no-color', 'serve'], env: {} });
    expect(chalk.level).toBe(0);
  });

  it('leaves colour enabled when neither flag nor env is set', () => {
    chalk.level = 3;
    initColorMode({ argv: ['node', 'hivectl', '--version'], env: {} });
    expect(chalk.level).toBe(3);
  });

  it('helpers return identity strings once colour is disabled', () => {
    initColorMode({ argv: ['node', 'hivectl'], env: { NO_COLOR: '1' } });
    expect(c.brand('hivectl')).toBe('hivectl');
    expect(c.muted('label')).toBe('label');
    expect(c.ok('done')).toBe('done');
    expect(c.err('boom')).toBe('boom');
    expect(c.head('Header')).toBe('Header');
    expect(c.num(42)).toBe('42');
  });
});
