// Banner shapes are immutable per [[hivectl — Operator Experience]]
// § Banner contract. Edits require a product spec amend (and likely an
// ADR if the change affects the wider design system). The literal
// glyph cluster is hard-coded by design — see the tech spec § "Banner
// como string vs como tagged template" decision (`banner.ts` is a
// linting anchor: a future eye-diff catches accidental shape drift).
//
// Two shapes:
//   - `compact(subtitle)` — daily banner. 3 lines with a glyph column
//     11 chars wide and the caller-supplied subtitle on line 3. The
//     subtitle text MUST come pre-coloured by the caller (typically
//     `c.muted(...)` for fresh/missing, `c.warn(...)` for stale) so
//     this module owns the brand cluster but never owns the state-
//     dependent semantics of the third line.
//   - `expanded()` — ceremonial 5-line banner reserved for `init`. The
//     glyph column is 21 chars wide; clusters of 4 / 6 / 8 hexagons are
//     centred to evoke the diamond/hex bloom shape of the design ref
//     (see `_design-references/hivectl-cli-redesign/07c hivectl v3.html`).
//     The text column on lines 2/4/5 is owned by this module — there
//     is exactly one caller (`output/init-ceremonial.ts::printBootHeader`).

import { HIVE_VERSION } from '@hive/shared';

import { c } from './colors.js';
import { sym } from './symbols.js';

// Banner version label. Single source of truth: `@hive/shared`'s
// `HIVE_VERSION`, rewritten to the release tag at build time by
// `release.yml`'s "Sync release version to source" step (PRY-060).
// Hardcoding the literal here would re-introduce the v0.1.5 bug where
// `hivectl --version` returned the synced version but the banner kept
// showing `v0.1.0` (PRY-068).
const VERSION_LABEL = `v${HIVE_VERSION}`;

// Built once at module load (per the tech spec § "No allocations in
// the banner" performance note). The narrow cluster is `⬢ ⬢ ⬢` (5
// chars wide); the wide cluster is `⬢ ⬢ ⬢ ⬢ ⬢` (9 chars wide). The
// 11-char column is achieved by adding 2 pad spaces on each side of
// the narrow cluster, so it visually overlaps the centre of the wide
// cluster on the line above.
const NARROW = `${sym.hex} ${sym.hex} ${sym.hex}`;
const WIDE = `${sym.hex} ${sym.hex} ${sym.hex} ${sym.hex} ${sym.hex}`;

// Expanded clusters: 4-, 6-, 8-hexagon rows. Each cluster is `N` glyphs
// joined by single spaces (visual width = 2N-1). Centred within the
// 21-char glyph column by the leading-space prefix on every line.
const N4 = `${sym.hex} ${sym.hex} ${sym.hex} ${sym.hex}`;
const N6 = `${sym.hex} ${sym.hex} ${sym.hex} ${sym.hex} ${sym.hex} ${sym.hex}`;
const N8 = `${sym.hex} ${sym.hex} ${sym.hex} ${sym.hex} ${sym.hex} ${sym.hex} ${sym.hex} ${sym.hex}`;

/**
 * Render the daily compact banner — three lines, glyph column 11 chars
 * wide, version/tagline/subtitle on the right column.
 *
 * The subtitle MUST be passed pre-coloured by the caller (no styling
 * decisions live here). The caller typically passes `c.muted(...)` for
 * fresh or no-snapshot states and `c.warn(...)` for stale.
 *
 * Output starts with 2-space indent on every line so the banner sits
 * in the same visual column as the cold-start status block (which uses
 * the same 2-space header indent for `status` / `try` / `verify`).
 */
export function compact(subtitle: string): string {
  const line1 = `  ${c.brand(`  ${NARROW}  `)}  ${c.cmd('hive')}${c.muted('ctl')}  ${c.muted('·')}  ${c.num(VERSION_LABEL)}  ${c.muted('·')}  apache-2.0`;
  const line2 = `  ${c.brand(WIDE)}  open-source MCP server for collaborative AI agents`;
  const line3 = `  ${c.brand(`  ${NARROW}  `)}  ${subtitle}`;
  return `${line1}\n${line2}\n${line3}`;
}

/**
 * Render the ceremonial expanded banner — five lines, glyph column 21
 * chars wide. Reserved for `hivectl init`: the operator runs `init`
 * exactly once per Hive, so the surface trades terseness for a small
 * "this is an event worth marking" cue. Every other subcommand uses
 * `compact()`.
 *
 * Layout (visual widths in NO_COLOR mode):
 *   line 1 — 4 hex (narrow top of the bloom)
 *   line 2 — 6 hex + `hivectl   ·   v0.1.0`
 *   line 3 — 8 hex (widest row)
 *   line 4 — 6 hex + `bootstrapping a fresh Hive`
 *   line 5 — 4 hex + `apache-2.0  ·  hivemine-ai/hive`
 *
 * The text on lines 2/4/5 is owned by this module — there is exactly
 * one caller (`output/init-ceremonial.ts::printBootHeader`) and the
 * ceremonial copy is fixed by the design ref. Editing the text
 * requires the same spec amend as editing the glyph layout.
 */
export function expanded(): string {
  const l1 = `       ${c.brand(N4)}`;
  const l2 = `     ${c.brand(N6)}      ${c.cmd('hive')}${c.muted('ctl')}   ${c.muted('·')}   ${c.num(VERSION_LABEL)}`;
  const l3 = `   ${c.brand(N8)}`;
  const l4 = `     ${c.brand(N6)}      ${c.muted('bootstrapping a fresh Hive')}`;
  const l5 = `       ${c.brand(N4)}        ${c.muted('apache-2.0  ·  hivemine-ai/hive')}`;
  return `${l1}\n${l2}\n${l3}\n${l4}\n${l5}`;
}
