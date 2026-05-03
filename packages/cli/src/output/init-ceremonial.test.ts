import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  printBootHeader,
  printCredentialBox,
  printCredentialWritten,
  startStep,
  type CeremonialSink,
} from './init-ceremonial.js';

// Detect ANSI SGR sequences via control char built from charCode (the
// `no-control-regex` ESLint rule flags raw ESC literals).
const ESC = String.fromCharCode(0x1b);
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`);

function bufferSink(): CeremonialSink & { read(): string } {
  const chunks: string[] = [];
  return {
    write(s: string): void {
      chunks.push(s);
    },
    read(): string {
      return chunks.join('');
    },
  };
}

describe('init-ceremonial.printBootHeader', () => {
  const previousLevel = chalk.level;
  beforeEach(() => {
    chalk.level = 0;
  });
  afterEach(() => {
    chalk.level = previousLevel;
  });

  it('writes the expanded banner followed by a blank separator line', () => {
    const sink = bufferSink();
    printBootHeader(sink);
    const out = sink.read();
    // Expanded banner has 5 lines + trailing blank = 6 newlines + the
    // empty line between banner and step rows.
    expect(out).toMatch(/⬢ ⬢ ⬢ ⬢ ⬢ ⬢ ⬢ ⬢/);
    expect(out.endsWith('\n\n')).toBe(true);
  });
});

describe('init-ceremonial.startStep', () => {
  const previousLevel = chalk.level;
  beforeEach(() => {
    chalk.level = 0;
  });
  afterEach(() => {
    chalk.level = previousLevel;
  });

  it('writes nothing on construction (deferred until complete/fail)', () => {
    const sink = bufferSink();
    startStep(1, 'database', sink);
    expect(sink.read()).toBe('');
  });

  it('renders a complete row with the success glyph and message', () => {
    const sink = bufferSink();
    startStep(1, 'database', sink).complete('opened sqlite:./var/db/hive.sqlite');
    expect(sink.read()).toBe('  [1/5] database            ✓ opened sqlite:./var/db/hive.sqlite\n');
  });

  it('renders a fail row with the error glyph and message', () => {
    const sink = bufferSink();
    startStep(3, 'signing key', sink).fail('keypair generation failed: EACCES');
    expect(sink.read()).toBe('  [3/5] signing key         ✗ keypair generation failed: EACCES\n');
  });

  it('emits ANSI sequences in colour mode for the prefix, glyph, and message', () => {
    chalk.level = 3;
    const sink = bufferSink();
    startStep(1, 'database', sink).complete('opened');
    expect(ANSI_RE.test(sink.read())).toBe(true);
  });

  it('pads short labels to the 18-char column for vertical alignment', () => {
    const sink = bufferSink();
    startStep(2, 'migrations', sink).complete('done');
    startStep(4, 'admin hivekeeper', sink).complete('done');
    const lines = sink.read().split('\n');
    // After `  [N/5] ` (8 chars including trailing space) the label
    // occupies cols 9-26 (18 chars). Column 27 is the gap, glyph at
    // col 29 — both lines must agree on the glyph column.
    const checkPos1 = lines[0]!.indexOf('✓');
    const checkPos2 = lines[1]!.indexOf('✓');
    expect(checkPos1).toBe(checkPos2);
  });

  it('renders the full 5-step ceremonial flow when used in sequence', () => {
    const sink = bufferSink();
    startStep(1, 'database', sink).complete('opened sqlite:./var/db/hive.sqlite');
    startStep(2, 'migrations', sink).complete('applied 7 / 7');
    startStep(3, 'signing key', sink).complete('generated kid sk-2026-001');
    startStep(4, 'admin hivekeeper', sink).complete('created hk-7f3e9a — admin@example.com');
    startStep(5, 'root credential', sink).complete('issued jti cr-d4f1c2 (ttl 365d)');
    expect(sink.read()).toBe(
      [
        '  [1/5] database            ✓ opened sqlite:./var/db/hive.sqlite',
        '  [2/5] migrations          ✓ applied 7 / 7',
        '  [3/5] signing key         ✓ generated kid sk-2026-001',
        '  [4/5] admin hivekeeper    ✓ created hk-7f3e9a — admin@example.com',
        '  [5/5] root credential     ✓ issued jti cr-d4f1c2 (ttl 365d)',
        '',
      ].join('\n'),
    );
  });
});

describe('init-ceremonial.printCredentialBox', () => {
  const previousLevel = chalk.level;
  beforeEach(() => {
    chalk.level = 0;
  });
  afterEach(() => {
    chalk.level = previousLevel;
  });

  it('renders warning + top-frame + token-row + bottom-frame', () => {
    const sink = bufferSink();
    const token = 'eyJhbGciOiJFZERTQSIsImtpZCI6InNrLTAwMSJ9.eyJzdWIiOiJoa180In0.signature';
    printCredentialBox(token, sink);
    const lines = sink.read().split('\n');
    expect(lines[0]).toContain('⚠');
    expect(lines[0]).toContain('save this token now — it is shown only once');
    expect(lines[1]).toBe(''); // blank between warning and box
    expect(lines[2]).toMatch(/^ {2}┌─{65}┐$/);
    expect(lines[3]).toMatch(/^ {2}│.+│$/);
    expect(lines[4]).toMatch(/^ {2}└─{65}┘$/);
  });

  it('pads short tokens to the 65-char inner width so the frame aligns', () => {
    const sink = bufferSink();
    printCredentialBox('short.token', sink);
    const lines = sink.read().split('\n');
    // Token row: `  │` (3) + 65 inner chars + `│` (1) = 69 chars before \n.
    expect(lines[3]!.length).toBe(69);
  });

  it('preserves exact-65-char tokens without padding or truncation', () => {
    const sink = bufferSink();
    const exactly65 = 'a'.repeat(65);
    printCredentialBox(exactly65, sink);
    const lines = sink.read().split('\n');
    expect(lines[3]).toBe(`  │${exactly65}│`);
  });

  it('lets long tokens overflow the right-hand frame intentionally', () => {
    const sink = bufferSink();
    const longToken = 'x'.repeat(100);
    printCredentialBox(longToken, sink);
    const lines = sink.read().split('\n');
    // Frame stays at 65 + 2 walls + 2-space indent = 69 chars; the token
    // row is wider because the token is not truncated. Spec § Casos
    // límite técnicos accepts this until a real long-token case surfaces.
    expect(lines[2]!.length).toBe(69);
    expect(lines[3]!.length).toBeGreaterThan(69);
    expect(lines[3]).toContain(longToken);
  });

  it('emits ANSI sequences in colour mode (warning, frame, token)', () => {
    chalk.level = 3;
    const sink = bufferSink();
    printCredentialBox('any.token.value', sink);
    expect(ANSI_RE.test(sink.read())).toBe(true);
  });
});

describe('init-ceremonial.printCredentialWritten', () => {
  const previousLevel = chalk.level;
  beforeEach(() => {
    chalk.level = 0;
  });
  afterEach(() => {
    chalk.level = previousLevel;
  });

  it('renders a check + path line followed by the single-shot file warning', () => {
    const sink = bufferSink();
    printCredentialWritten('./var/secrets/admin.jwt', sink);
    expect(sink.read()).toBe(
      [
        '  ✓ root credential written to ./var/secrets/admin.jwt',
        '  ⚠ this token is the ONLY admin credential — keep the file safe',
        '',
      ].join('\n'),
    );
  });
});
