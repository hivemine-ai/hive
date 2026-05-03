// Hive OSS terminal glyph vocabulary — the closed set of single-character
// symbols used across the CLI surface. Coloured at the call site by
// composing with helpers from `./colors.ts` (e.g. `c.brand(sym.hex)`).
//
// HARD CONVENTION (per ADR-021 + the CLI redesign handoff): no other
// CLI file may emit hex glyphs (⬡, ⬢) or status dots (●, ○) inline.
// Every glyph reference must come from `sym`. New entries are added
// here as the design system grows; ad-hoc glyphs in call sites are a
// review fix.

export const sym = {
  prompt: '⬡', // honey, leads every "$ hivectl ..." example line
  hex: '⬢', // honey, used in the banner cluster
  dot: '●', // semantic: ok / warn / err
  dotEmpty: '○', // muted: idle / unknown
  check: '✓',
  cross: '✗',
  warn: '⚠',
  rule: '─',
} as const;

export type SymbolKey = keyof typeof sym;
