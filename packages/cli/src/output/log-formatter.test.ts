import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { determineModulePathPadding, formatLogLine, type FormatPadding } from './log-formatter.js';

// All assertions in this file run under chalk.level=0 so the formatter
// output is byte-stable (no ANSI SGR codes). Tests for ANSI emission
// live in a single ANSI smoke block below where chalk.level=3 is forced.
// Pattern matches `cold-start.test.ts` from PRY-049 ("renderer drives the
// fixture, NOT the eye" — fixtures are derived from the real renderer
// output captured under NO_COLOR, not hand-typed).

const PADDING_DEFAULT: FormatPadding = { modulePathWidth: 20 };

// 2026-05-03T12:34:56.789 (UTC). Tests format using local time so the
// expected timestamp is computed with the same Date instance to stay
// deterministic across CI timezones (CI runs in UTC, dev runs in CET,
// etc.). The visible chars are 12 (hh:mm:ss.mmm), invariant.
const FIXED_TIME_MS = 1_770_000_000_000;
const FIXED_TIME_STR = (() => {
  const d = new Date(FIXED_TIME_MS);
  const pad2 = (n: number): string => String(n).padStart(2, '0');
  const pad3 = (n: number): string => String(n).padStart(3, '0');
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
})();

function buildLine(extras: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    level: 30,
    time: FIXED_TIME_MS,
    module: 'composition.wire',
    msg: 'wire_started',
    ...extras,
  };
}

describe('PRY-051 — formatLogLine (NO_COLOR byte-stable)', () => {
  const previousLevel = chalk.level;

  beforeEach(() => {
    chalk.level = 0;
  });

  afterEach(() => {
    chalk.level = previousLevel;
  });

  it('formats an INFO line with module + msg + no extras', () => {
    const out = formatLogLine(buildLine(), PADDING_DEFAULT);
    expect(out).toBe(`${FIXED_TIME_STR}  INFO   composition.wire      wire_started`);
  });

  it('formats a DEBUG line (pino level 20)', () => {
    const out = formatLogLine(buildLine({ level: 20 }), PADDING_DEFAULT);
    expect(out).toBe(`${FIXED_TIME_STR}  DEBUG  composition.wire      wire_started`);
  });

  it('formats a WARN line (pino level 40)', () => {
    const out = formatLogLine(buildLine({ level: 40 }), PADDING_DEFAULT);
    expect(out).toBe(`${FIXED_TIME_STR}  WARN   composition.wire      wire_started`);
  });

  it('formats an ERROR line (pino level 50)', () => {
    const out = formatLogLine(buildLine({ level: 50 }), PADDING_DEFAULT);
    expect(out).toBe(`${FIXED_TIME_STR}  ERROR  composition.wire      wire_started`);
  });

  it('collapses fatal (60) to ERROR chip', () => {
    const out = formatLogLine(buildLine({ level: 60, msg: 'wire_fatal' }), PADDING_DEFAULT);
    expect(out).toBe(`${FIXED_TIME_STR}  ERROR  composition.wire      wire_fatal`);
  });

  it('collapses trace (10) to DEBUG chip', () => {
    const out = formatLogLine(buildLine({ level: 10 }), PADDING_DEFAULT);
    expect(out).toBe(`${FIXED_TIME_STR}  DEBUG  composition.wire      wire_started`);
  });

  it('falls back to "-" (still padded) when module field is missing', () => {
    const line = buildLine();
    delete line['module'];
    const out = formatLogLine(line, PADDING_DEFAULT);
    expect(out).toBe(`${FIXED_TIME_STR}  INFO   -                     wire_started`);
  });

  it('falls back to "-" when module field is empty string', () => {
    const out = formatLogLine(buildLine({ module: '' }), PADDING_DEFAULT);
    expect(out).toBe(`${FIXED_TIME_STR}  INFO   -                     wire_started`);
  });

  it('emits empty msg column when msg field is missing', () => {
    const line = buildLine({ event: 'wire_started' });
    delete line['msg'];
    const out = formatLogLine(line, PADDING_DEFAULT);
    expect(out).toBe(`${FIXED_TIME_STR}  INFO   composition.wire        event=wire_started`);
  });

  it('appends k=v extras (excluding reserved keys)', () => {
    const out = formatLogLine(
      buildLine({
        event: 'wire_started',
        port: 7700,
        bind: '127.0.0.1',
      }),
      PADDING_DEFAULT,
    );
    expect(out).toBe(
      `${FIXED_TIME_STR}  INFO   composition.wire      wire_started  event=wire_started port=7700 bind=127.0.0.1`,
    );
  });

  it('serialises object/array extras as JSON', () => {
    const out = formatLogLine(
      buildLine({
        cfg: { httpPort: 7700 },
        tags: ['a', 'b'],
        flag: true,
        ratio: 0.5,
        empty: null,
      }),
      PADDING_DEFAULT,
    );
    expect(out).toBe(
      `${FIXED_TIME_STR}  INFO   composition.wire      wire_started  cfg={"httpPort":7700} tags=["a","b"] flag=true ratio=0.5 empty=null`,
    );
  });

  it('serialises Error extras as their message', () => {
    const out = formatLogLine(
      buildLine({
        msg: 'wire_boot_failed',
        err: new Error('keys not found'),
      }),
      PADDING_DEFAULT,
    );
    expect(out).toBe(
      `${FIXED_TIME_STR}  INFO   composition.wire      wire_boot_failed  err=keys not found`,
    );
  });

  it('skips pino bookkeeping fields (pid, hostname, v) from extras', () => {
    const out = formatLogLine(
      buildLine({
        pid: 1234,
        hostname: 'macbook',
        v: 1,
        event: 'wire_started',
      }),
      PADDING_DEFAULT,
    );
    expect(out).toBe(
      `${FIXED_TIME_STR}  INFO   composition.wire      wire_started  event=wire_started`,
    );
  });

  it('aligns columns cross-lines under a shared padding (visual smoke)', () => {
    const lines = [
      formatLogLine(buildLine({ module: 'wire' }), PADDING_DEFAULT),
      formatLogLine(buildLine({ module: 'composition.wire' }), PADDING_DEFAULT),
      formatLogLine(buildLine({ module: 'transport.mcp.server.long.name' }), PADDING_DEFAULT),
    ];
    // Column 0..11   = timestamp   (12 chars)
    // Column 12..13  = sep "  "
    // Column 14..18  = level chip  (5 chars)
    // Column 19..20  = sep "  "
    // Column 21..N   = module padded
    for (const line of lines) {
      expect(line.slice(0, 12)).toBe(FIXED_TIME_STR);
      expect(line.slice(12, 14)).toBe('  ');
      expect(line.slice(14, 19)).toBe('INFO ');
      expect(line.slice(19, 21)).toBe('  ');
    }
    // The module column extends until the next double-space separator. The
    // first two lines use the default padding (20 chars); the third has a
    // module wider than the padding (30 chars) so the column auto-extends
    // — operators see one slightly long line rather than a truncated name.
    // The msg start is at column 21 + max(modulePathWidth, module.length) + 2.
    const msgStart0 = lines[0]!.indexOf('wire_started');
    const msgStart1 = lines[1]!.indexOf('wire_started');
    const msgStart2 = lines[2]!.indexOf('wire_started');
    expect(msgStart0).toBe(21 + 20 + 2);
    expect(msgStart1).toBe(21 + 20 + 2);
    expect(msgStart2).toBe(21 + 'transport.mcp.server.long.name'.length + 2);
  });

  it('honours an explicit modulePathWidth when callers raise the column', () => {
    const out = formatLogLine(buildLine(), { modulePathWidth: 30 });
    expect(out).toBe(`${FIXED_TIME_STR}  INFO   composition.wire                wire_started`);
  });

  it('formats time from Date.now() when line.time is missing (defensive)', () => {
    const line = buildLine();
    delete line['time'];
    const out = formatLogLine(line, PADDING_DEFAULT);
    // 12-char timestamp prefix "hh:mm:ss.mmm" — body irrelevant.
    expect(out).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}\s{2}INFO\s\s{2}composition\.wire/);
  });

  it('accepts string-form pino levels (defensive — some pipelines stringify)', () => {
    const cases: Array<[string, string]> = [
      ['info', 'INFO '],
      ['warn', 'WARN '],
      ['error', 'ERROR'],
      ['debug', 'DEBUG'],
      ['trace', 'DEBUG'],
      ['fatal', 'ERROR'],
    ];
    for (const [input, expectedChip] of cases) {
      const out = formatLogLine(buildLine({ level: input }), PADDING_DEFAULT);
      expect(out).toBe(`${FIXED_TIME_STR}  ${expectedChip}  composition.wire      wire_started`);
    }
  });

  it('defaults to INFO chip on unknown level (defensive)', () => {
    const out = formatLogLine(buildLine({ level: 999 }), PADDING_DEFAULT);
    expect(out).toBe(`${FIXED_TIME_STR}  INFO   composition.wire      wire_started`);
  });
});

describe('PRY-051 — formatLogLine emits ANSI when chalk is enabled (smoke)', () => {
  const previousLevel = chalk.level;
  const ESC = String.fromCharCode(0x1b);
  const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`);

  beforeEach(() => {
    chalk.level = 3;
  });

  afterEach(() => {
    chalk.level = previousLevel;
  });

  it('wraps the timestamp, level chip, module, and extras in ANSI codes', () => {
    const out = formatLogLine(
      {
        level: 50,
        time: FIXED_TIME_MS,
        module: 'transport.mcp',
        msg: 'mcp_subscribe_failed',
        event: 'mcp_subscribe_failed',
      },
      PADDING_DEFAULT,
    );
    expect(ANSI_RE.test(out)).toBe(true);
    // Visible characters survive the colour wrapping.
    expect(out).toContain(FIXED_TIME_STR);
    expect(out).toContain('ERROR');
    expect(out).toContain('transport.mcp');
    expect(out).toContain('mcp_subscribe_failed');
    expect(out).toContain('event=mcp_subscribe_failed');
  });
});

describe('PRY-051 — determineModulePathPadding', () => {
  it('returns 20 (= max(0, 18) + 2) when knownNamespaces is empty', () => {
    expect(determineModulePathPadding([])).toBe(20);
  });

  it('returns 20 when all known namespaces are shorter than 18', () => {
    expect(determineModulePathPadding(['wire', 'mcp', 'auth'])).toBe(20);
  });

  it('returns longest + 2 when at least one namespace exceeds 18 chars', () => {
    expect(determineModulePathPadding(['composition.wire', 'transport.mcp.server'])).toBe(
      'transport.mcp.server'.length + 2,
    );
  });

  it('matches the spec formula: MAX(longest, 18) + 2 (boundary 18-char case)', () => {
    // 'transport.mcp.tool' is exactly 18 chars.
    expect(determineModulePathPadding(['transport.mcp.tool'])).toBe(20);
  });
});
