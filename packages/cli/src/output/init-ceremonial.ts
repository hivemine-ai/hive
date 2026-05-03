// Init ceremonial — used ONLY by `hivectl init` per the
// [[hivectl — Operator Experience]] product spec, "Use Case 1" and
// "Init ceremony" sections.
//
// Bootstrap is the singular operation of an operator's lifetime against
// a Hive: it happens exactly once per machine. The handoff treats it
// deliberately theatrical — expanded banner + 5-step staged progress +
// framed credential box — to communicate "this is an event worth
// marking". Every other subcommand uses `compact()` + functional output.
//
// Contract:
//   - `printBootHeader()` writes the expanded banner + a blank line.
//   - `startStep(n, label)` returns a `StepHandle` that does NOT print
//     anything yet; `complete(msg)` / `fail(msg)` write the row.
//     Spinner during "in progress" is OUT-OF-SCOPE per the PRY
//     (render-incremental + complete-final is sufficient — see the
//     PRY's "Out of scope" section). Each step row is a single line so
//     the output stays readable in non-TTY contexts (CI logs, piped
//     to file).
//   - `printCredentialBox(token)` writes the warning + framed box.
//     Caller decides whether to invoke this (skip when
//     `--output-credential <file>` is set; the token belongs in the
//     file, never on stdout).
//
// HARD CONVENTION: this module is the ONLY caller of `banner.expanded()`
// in the codebase. New callers require a product spec amend.
//
// Sink injection: every public function accepts a `CeremonialSink` so
// tests assert byte-stable output without spying on `process.stdout`.

import { expanded } from './banner.js';
import { c } from './colors.js';
import { sym } from './symbols.js';

const TOTAL_STEPS = 5;
const LABEL_WIDTH = 18;
const BOX_INNER_WIDTH = 65;

export interface CeremonialSink {
  write(s: string): void;
}

const defaultSink: CeremonialSink = {
  write(s: string): void {
    process.stdout.write(s);
  },
};

/**
 * Print the expanded ceremonial banner + a blank line. Called once at
 * the top of `runInit` in pretty mode.
 */
export function printBootHeader(sink: CeremonialSink = defaultSink): void {
  sink.write(`${expanded()}\n\n`);
}

export interface StepHandle {
  complete(message: string): void;
  fail(message: string): void;
}

/**
 * Begin a new bootstrap step. Returns a handle the caller resolves with
 * `complete(msg)` (success path) or `fail(msg)` (failure path). Nothing
 * is written until the handle is resolved — keeps the output readable
 * in CI logs (no half-rendered spinner lines).
 *
 * Layout: `  [N/5] <label padded to 18>  <glyph> <message>`. The
 * 2-space leading indent matches the cold-start status block so the
 * ceremonial output sits in the same visual column as the rest of the
 * CLI surface.
 */
export function startStep(
  n: 1 | 2 | 3 | 4 | 5,
  label: string,
  sink: CeremonialSink = defaultSink,
): StepHandle {
  const prefix = `  ${c.muted(`[${n}/${TOTAL_STEPS}]`)} ${label.padEnd(LABEL_WIDTH)}`;
  return {
    complete(message: string): void {
      sink.write(`${prefix}  ${c.ok(sym.check)} ${c.muted(message)}\n`);
    },
    fail(message: string): void {
      sink.write(`${prefix}  ${c.err(sym.cross)} ${c.err(message)}\n`);
    },
  };
}

/**
 * Print the warning line + framed credential box.
 *
 * Frame: ┌─────…─┐ over │<token>│ over └─────…─┘. Inner pad width is a
 * fixed 65 chars per the tech spec "Technical edge cases" section —
 * sized to the realistic JWT length for v0.1 (3 segments × ~50 chars
 * each ≈ box width). A token longer than 65 chars overflows the
 * right-hand frame intentionally; the spec accepts this until a real
 * long-token case surfaces (then amend the padding).
 *
 * The warning is a single line above the box so screen-readers and
 * grep-on-the-output flows can find "save this token" without parsing
 * the frame.
 */
export function printCredentialBox(token: string, sink: CeremonialSink = defaultSink): void {
  const warning = `  ${c.warn(sym.warn)} ${c.warn('save this token now — it is shown only once')}`;
  const top = `  ${c.subtle(`┌${sym.rule.repeat(BOX_INNER_WIDTH)}┐`)}`;
  const bot = `  ${c.subtle(`└${sym.rule.repeat(BOX_INNER_WIDTH)}┘`)}`;
  const padded = token.length >= BOX_INNER_WIDTH ? token : token.padEnd(BOX_INNER_WIDTH);
  const mid = `  ${c.subtle('│')}${c.brand(padded)}${c.subtle('│')}`;
  sink.write(`${warning}\n\n${top}\n${mid}\n${bot}\n`);
}

/**
 * Print a one-line confirmation that the credential was written to a
 * file (used when `--output-credential <path>` is set instead of
 * `printCredentialBox`). The single-shot warning still applies to the
 * file content — phrased differently because the surface is different.
 */
export function printCredentialWritten(path: string, sink: CeremonialSink = defaultSink): void {
  sink.write(`  ${c.ok(sym.check)} ${c.muted(`root credential written to ${path}`)}\n`);
  sink.write(
    `  ${c.warn(sym.warn)} ${c.warn('this token is the ONLY admin credential — keep the file safe')}\n`,
  );
}
