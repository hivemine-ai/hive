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
//   - `expanded()` — ceremonial 5-line banner reserved for `init`.
//     Implemented in Slice 5 (PRY-052); throws explicitly until then
//     so an accidental caller fails loudly instead of shipping an
//     empty string.

import { c } from './colors.js';
import { sym } from './symbols.js';

// Built once at module load (per the tech spec § "No allocations in
// the banner" performance note). The narrow cluster is `⬢ ⬢ ⬢` (5
// chars wide); the wide cluster is `⬢ ⬢ ⬢ ⬢ ⬢` (9 chars wide). The
// 11-char column is achieved by adding 2 pad spaces on each side of
// the narrow cluster, so it visually overlaps the centre of the wide
// cluster on the line above.
const NARROW = `${sym.hex} ${sym.hex} ${sym.hex}`;
const WIDE = `${sym.hex} ${sym.hex} ${sym.hex} ${sym.hex} ${sym.hex}`;

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
  const line1 = `  ${c.brand(`  ${NARROW}  `)}  ${c.cmd('hive')}${c.muted('ctl')}  ${c.muted('·')}  ${c.num('v0.1.0')}  ${c.muted('·')}  apache-2.0`;
  const line2 = `  ${c.brand(WIDE)}  open-source MCP server for collaborative AI agents`;
  const line3 = `  ${c.brand(`  ${NARROW}  `)}  ${subtitle}`;
  return `${line1}\n${line2}\n${line3}`;
}

/**
 * Render the ceremonial expanded banner. Reserved for `hivectl init`
 * (and the first-run `serve` after a fresh install).
 *
 * NOT YET IMPLEMENTED — lands in Slice 5 (PRY-052). Throwing here keeps
 * the module honest: an accidental caller fails loudly and points to
 * the right PRY rather than shipping an empty banner that quietly
 * breaks the ceremony.
 */
export function expanded(): string {
  throw new Error('banner.expanded() not yet implemented — lands in PRY-052 (Slice 5)');
}
