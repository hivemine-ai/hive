// Hive OSS terminal palette — derived from tokens.css.
// Keep these values in sync if tokens.css changes (see ADR-021).
//
// Hex tokens here are the canonical mapping from the design system's
// `oklch(...)` declarations, lifted from the CLI redesign handoff README
// (single source of truth: `03 - Productos/Hive/_design-references/
// hivectl-cli-redesign/README.md` § "Token source"). Only the dark
// variants are exposed — the CLI assumes a dark terminal by default.
// A future `--theme=light` flag would add a sibling `paletteLight`
// without touching call sites (helpers in `c` would consult the active
// palette).
//
// HARD CONVENTION (per ADR-021): no other CLI file may call
// `chalk.hex(...)`, `chalk.bold(...)`, or any other chalk modifier
// directly. Every coloured fragment must come from a helper in `c`.
// Verified via:
//   grep -rE "chalk\." packages/cli/src --include="*.ts" \
//     | grep -vE "output/colors(\.test)?\.ts"
// returning empty. The pattern excludes both the production module
// and its test file (the literal `output/colors.ts` substring is
// not contained in `output/colors.test.ts` because `.test` breaks
// the contiguity, so an unrefined `grep -v` would wrongly flag the
// test file as a violation).

import chalk from 'chalk';

export const palette = {
  // Brand
  honey: '#E8A02C', // --hv-honey-500            — prompts, banner, identifiers
  honeyDim: '#9C6E1E', // --hv-honey-700         — subtle brand accents (reserved)

  // Neutrals (dark variant — bone-on-ink)
  text: '#E8E4DA', // --hv-text on dark         — default foreground
  muted: '#9A958A', // --hv-text-muted on dark  — labels, timestamps, hints
  subtle: '#6E6A60', // --hv-text-subtle on dark — separators, frame characters

  // Semantic state
  ok: '#5FA86B', // --hv-success-500             — ● active, ✓
  warn: '#D8A53C', // --hv-warn-500              — ● stale, ⚠, suspended
  err: '#C8553D', // --hv-error-500              — ✗, fatal
  info: '#4F8FB3', // --hv-info-500              — DEBUG/INFO chips
} as const;

export type PaletteKey = keyof typeof palette;

export type LevelChipToken = 'INFO' | 'DEBUG' | 'WARN ' | 'ERROR';

export const c = {
  prompt: (s: string): string => chalk.hex(palette.honey)(s),
  brand: (s: string): string => chalk.hex(palette.honey)(s),
  cmd: (s: string): string => chalk.hex(palette.text).bold(s),
  flag: (s: string): string => chalk.hex(palette.muted)(s),
  arg: (s: string): string => chalk.hex(palette.text)(s),
  str: (s: string): string => chalk.hex(palette.honey)(s),
  num: (s: string | number): string => chalk.hex(palette.honey)(String(s)),
  muted: (s: string): string => chalk.hex(palette.muted)(s),
  ok: (s: string): string => chalk.hex(palette.ok)(s),
  warn: (s: string): string => chalk.hex(palette.warn)(s),
  err: (s: string): string => chalk.hex(palette.err)(s),
  info: (s: string): string => chalk.hex(palette.info)(s),
  head: (s: string): string => chalk.hex(palette.text).bold(s),
  // Fixed-width 5-char chip used by the log-stream formatter (Slice 4).
  // Tokens are padded right when needed so the column stays aligned
  // (e.g. 'WARN ' has a trailing space, 'INFO' is 4 chars then a space
  // is added by the caller — handled here by routing on the trimmed
  // token so callers may pass either the padded or unpadded form).
  //
  // NOTE for Slice 4 (PRY-051): when extending `LevelChipToken` with a
  // new member, refactor the ternary chain below to a `switch` with a
  // `default: const _: never = trimmed; return c.muted(lvl);` branch so
  // a future omitted case fails at compile time instead of silently
  // rendering as muted. Pattern documented in `_meta/lessons-pry.md`
  // PRY-003 (exhaustiveness guard for discriminated-union mappers).
  levelChip: (lvl: LevelChipToken): string => {
    const trimmed = lvl.trim();
    const colour =
      trimmed === 'ERROR'
        ? c.err
        : trimmed === 'WARN'
          ? c.warn
          : trimmed === 'DEBUG'
            ? c.info
            : c.muted;
    return colour(lvl);
  },
};

export interface ColorModeOptions {
  /** Argv to scan for `--no-color`. Defaults to `process.argv`. */
  argv?: readonly string[];
  /** Env to read `NO_COLOR` from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Initialise chalk's colour level based on `NO_COLOR` env var (per
 * https://no-color.org — any non-empty value disables colour) and the
 * `--no-color` CLI flag. Call once at boot, before any helper in `c`
 * is invoked.
 *
 * Idempotent. Sets `chalk.level = 0` only if either signal is present;
 * leaves it untouched otherwise (so callers can opt into a higher level
 * upstream if needed).
 */
export function initColorMode(opts: ColorModeOptions = {}): void {
  const argv = opts.argv ?? process.argv;
  const env = opts.env ?? process.env;
  const noColorEnv = env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '';
  const noColorFlag = argv.includes('--no-color');
  if (noColorEnv || noColorFlag) {
    chalk.level = 0;
  }
}
