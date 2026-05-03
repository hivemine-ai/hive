// Reusable help renderer for `hivectl --help` and every
// `hivectl <subcommand> --help`. Pure function: takes plain structured
// data (no commander coupling) and returns a multi-line string ready for
// `process.stdout.write`. The adapter that pulls structured data from
// commander commands lives in `program-help-adapter.ts`.
//
// Visual contract is anchored against the design HTML reference at
// `03 - Productos/Hive/_design-references/hivectl-cli-redesign/
// 07c hivectl v3.html` § 2 (top-level) and § 3 (subgroup). The contract
// preserves these invariants:
//   - Total line width ≤ 100 columns (enforced by truncation when the
//     description would push the line past the limit).
//   - Headings (`usage`, `commands · server`, `global options`, etc.)
//     in `c.head` (bold).
//   - Command names in `c.cmd` (bold). Option flags in `c.flag` (muted).
//   - Inline argument hints (e.g. `<fmt>`) and example commands in
//     `c.arg`. Descriptions in `c.muted`. The prompt glyph echoing the
//     invocation in `c.prompt`.
//   - Two-space indent for section headers, four-space indent for rows.
//
// The renderer never colours its inputs — every helper applies colour
// at the call site so that the same input can drive both the coloured
// terminal output and the byte-identical NO_COLOR snapshot fixtures.

import { c } from './colors.js';
import { sym } from './symbols.js';

/** Width invariant — every emitted line must fit within this column count. */
export const HELP_MAX_WIDTH = 100;

/**
 * Single command row inside a help screen — either a top-level
 * subcommand (`init`, `serve`, …) or a subgroup verb (`install`,
 * `start`, …).
 */
export interface CommandSummary {
  /** The command name as the operator types it. */
  name: string;
  /**
   * Optional inline argument cluster shown right after the name, e.g.
   * `[--user|--system]` or `[--logs N]`. Rendered in `c.arg`.
   */
  args?: string;
  /** One-line description shown after the name + args column. */
  description: string;
}

/**
 * A category-labelled bundle of commands for the top-level help. The
 * label appears in the heading as `commands · <category>`. Subgroup
 * help uses a flat list (no category) — see `SubgroupHelpInput`.
 */
export interface CommandGroup {
  /** Category label, e.g. `server`, `participants`, `observability`. */
  category: string;
  commands: ReadonlyArray<CommandSummary>;
}

/** Single global / subcommand option row. */
export interface OptionSummary {
  /**
   * Flags string as it appears in the screen, e.g. `-o, --output <fmt>`
   * or `    --no-color`. The renderer respects whatever leading space
   * the caller chose so that aliasless options align with their
   * shortcut-prefixed siblings.
   */
  flags: string;
  /** One-line description. */
  description: string;
}

/** Optional examples block (subgroup help only, but supported anywhere). */
export interface ExampleEntry {
  /** Comment line shown above the command, rendered in `c.muted`. */
  comment: string;
  /** Shell command line, prefixed by the prompt glyph at render time. */
  command: string;
}

/** Optional cross-reference block (subgroup help only). */
export interface SeeAlsoEntry {
  /** The referenced command, e.g. `hivectl serve`. */
  command: string;
  /** One-line note. */
  description: string;
}

/** Input shape for `renderTopLevelHelp`. */
export interface TopLevelHelpInput {
  /** Full invocation echoed on the first line, e.g. `hivectl --help`. */
  invocation: string;
  /** Program label inside the title block, e.g. `hivectl`. */
  programLabel: string;
  /** Short tagline shown after the title `·` separator. */
  tagline: string;
  /** Multi-word description shown indented below the title. */
  description: string;
  /** Usage syntax line, e.g. `hivectl [options] <command>`. */
  usage: string;
  /** Command groups in display order. */
  groups: ReadonlyArray<CommandGroup>;
  /** Global options in display order. */
  globalOptions: ReadonlyArray<OptionSummary>;
  /** Footer line, e.g. `run hivectl <command> --help for command-specific help.` */
  footer: string;
}

/** Input shape for `renderSubgroupHelp`. */
export interface SubgroupHelpInput {
  /** Full invocation echoed on the first line, e.g. `hivectl service --help`. */
  invocation: string;
  /** Program label inside the title block, e.g. `hivectl service`. */
  programLabel: string;
  /** Short tagline shown after the title `·` separator. */
  tagline: string;
  /** Multi-word description shown indented below the title. */
  description: string;
  /** Usage syntax line, e.g. `hivectl service <command> [options]`. */
  usage: string;
  /** Flat command list (no categories). */
  commands: ReadonlyArray<CommandSummary>;
  /** Global options in display order. */
  globalOptions: ReadonlyArray<OptionSummary>;
  /** Optional examples block. */
  examples?: ReadonlyArray<ExampleEntry>;
  /** Optional cross-reference block. */
  seeAlso?: ReadonlyArray<SeeAlsoEntry>;
}

// Indentation primitives — kept module-private so the renderer owns
// every spacing decision. Section headers indent 2 spaces, rows indent
// 4 spaces. The 2-space step matches the cold-start renderer's status
// block indent so the operator's eye anchors on the same column across
// subcommands.
const SECTION_INDENT = '  ';
const ROW_INDENT = '    ';

// Gap between the name+args column and the description column. Two
// spaces is the standard column separator across the design system —
// matches the cold-start status block label gap.
const COL_GAP = '  ';

// Minimum gap between the flags column and the description column.
const OPTION_GAP = '     ';

/**
 * Compose a command row: padded name + optional args + description.
 * The plain (no-ANSI) length is computed first to apply the width
 * truncation; only then is colour applied to the chunks. Because chalk
 * adds zero terminal-visible width, the coloured output preserves the
 * truncation guarantee.
 */
function formatCommandRow(
  cmd: CommandSummary,
  nameColumnWidth: number,
  argsColumnWidth: number,
  rowPrefix: string,
): string {
  const namePlain = cmd.name.padEnd(nameColumnWidth);
  const argsPlain = (cmd.args ?? '').padEnd(argsColumnWidth);
  const prefix = `${rowPrefix}${namePlain}${COL_GAP}${argsPlain}${COL_GAP}`;
  const descBudget = HELP_MAX_WIDTH - prefix.length;
  const description = truncate(cmd.description, Math.max(0, descBudget));
  const nameColoured = c.cmd(namePlain);
  const argsColoured = argsPlain.length === 0 ? '' : c.arg(argsPlain);
  return `${rowPrefix}${nameColoured}${COL_GAP}${argsColoured}${COL_GAP}${c.muted(description)}`;
}

/** Same as `formatCommandRow` but for option rows (flags + description). */
function formatOptionRow(opt: OptionSummary, flagsColumnWidth: number, rowPrefix: string): string {
  const flagsPlain = opt.flags.padEnd(flagsColumnWidth);
  const prefix = `${rowPrefix}${flagsPlain}${OPTION_GAP}`;
  const descBudget = HELP_MAX_WIDTH - prefix.length;
  const description = truncate(opt.description, Math.max(0, descBudget));
  return `${rowPrefix}${c.flag(flagsPlain)}${OPTION_GAP}${c.muted(description)}`;
}

/**
 * Truncate a description so the full row stays within `HELP_MAX_WIDTH`.
 * When budget < 4 the result is the empty string (not enough room for
 * a meaningful ellipsis); otherwise the description is cut and ended
 * with a single-character `…` to communicate truncation without using
 * the byte-noisy `...` triplet.
 */
export function truncate(text: string, budget: number): string {
  if (budget <= 0) return '';
  if (text.length <= budget) return text;
  if (budget < 2) return text.slice(0, budget);
  return `${text.slice(0, budget - 1)}…`;
}

/**
 * Compute the width of the "name + args" column for top-level + subgroup
 * help. The longest plain-name + plain-args sets the column; we cap at a
 * sensible upper bound (38) so a single absurdly long name does not
 * push the description column off the right edge. Beyond the cap, the
 * row simply gets less padding (no truncation of the name itself —
 * names are first-class identifiers).
 */
function computeNameColumn(commands: ReadonlyArray<CommandSummary>): number {
  let maxName = 0;
  for (const cmd of commands) {
    if (cmd.name.length > maxName) maxName = cmd.name.length;
  }
  return Math.min(maxName, 38);
}

function computeArgsColumn(commands: ReadonlyArray<CommandSummary>): number {
  let maxArgs = 0;
  for (const cmd of commands) {
    const len = (cmd.args ?? '').length;
    if (len > maxArgs) maxArgs = len;
  }
  return maxArgs;
}

function computeFlagsColumn(options: ReadonlyArray<OptionSummary>): number {
  let max = 0;
  for (const opt of options) {
    if (opt.flags.length > max) max = opt.flags.length;
  }
  return Math.min(max, 38);
}

function renderEcho(invocation: string): string {
  // The echo line mirrors how the operator just typed the command; the
  // prompt glyph in honey provides the visual anchor and the rest is
  // rendered in `c.cmd` for the program name and `c.flag` for the
  // flag(s). Because the renderer cannot tell where the program name
  // ends and the flags/positional begin without parsing, we apply
  // `c.cmd` to the full echoed text — chalk just colours the whole
  // sequence honey, matching the visual design weight.
  // Width-invariant guard: prompt glyph + space = 2 visible cols; the
  // `truncate` budget for the invocation text is therefore 98.
  const safeInvocation = truncate(invocation, HELP_MAX_WIDTH - 2);
  return `${c.prompt(sym.prompt)} ${c.cmd(safeInvocation)}`;
}

function renderTitleBlock(programLabel: string, tagline: string, description: string): string {
  // Title block: 2-space indent + brand glyph + program label + ` · ` +
  // tagline; continuation line indented 4 spaces with the multi-word
  // description in `c.muted`.
  // Width-invariant guard: title prefix is `<2 indent><1 hex glyph>
  // <1 space><label><1 space><1 ·><1 space>` = 7 + label visible chars;
  // truncate the tagline to fit. Description line is `<4 indent>` + the
  // body, truncated to 96.
  const titlePrefixCols = SECTION_INDENT.length + 1 + 1 + programLabel.length + 1 + 1 + 1;
  const safeTagline = truncate(tagline, Math.max(0, HELP_MAX_WIDTH - titlePrefixCols));
  const titleLine = `${SECTION_INDENT}${c.brand(sym.hex)} ${c.cmd(programLabel)} ${c.muted('·')} ${safeTagline}`;
  const safeDescription = truncate(description, HELP_MAX_WIDTH - ROW_INDENT.length);
  const descLine = `${ROW_INDENT}${c.muted(safeDescription)}`;
  return `${titleLine}\n${descLine}`;
}

function renderUsage(usage: string): string {
  // Width-invariant guard: row indent is 4 cols; truncate the usage
  // text to fit within `HELP_MAX_WIDTH - 4` visible cols.
  const safeUsage = truncate(usage, HELP_MAX_WIDTH - ROW_INDENT.length);
  return [`${SECTION_INDENT}${c.head('usage')}`, `${ROW_INDENT}${c.cmd(safeUsage)}`].join('\n');
}

function renderGroup(group: CommandGroup): string {
  const heading = `${SECTION_INDENT}${c.head(`commands ${c.muted('·')} ${group.category}`)}`;
  const nameWidth = computeNameColumn(group.commands);
  const argsWidth = computeArgsColumn(group.commands);
  const rows = group.commands.map((cmd) => formatCommandRow(cmd, nameWidth, argsWidth, ROW_INDENT));
  return [heading, ...rows].join('\n');
}

function renderFlatCommands(commands: ReadonlyArray<CommandSummary>): string {
  const heading = `${SECTION_INDENT}${c.head('commands')}`;
  const nameWidth = computeNameColumn(commands);
  const argsWidth = computeArgsColumn(commands);
  const rows = commands.map((cmd) => formatCommandRow(cmd, nameWidth, argsWidth, ROW_INDENT));
  return [heading, ...rows].join('\n');
}

function renderGlobalOptions(options: ReadonlyArray<OptionSummary>): string {
  const heading = `${SECTION_INDENT}${c.head('global options')}`;
  const flagsWidth = computeFlagsColumn(options);
  const rows = options.map((opt) => formatOptionRow(opt, flagsWidth, ROW_INDENT));
  return [heading, ...rows].join('\n');
}

function renderExamples(examples: ReadonlyArray<ExampleEntry>): string {
  const heading = `${SECTION_INDENT}${c.head('examples')}`;
  const blocks: string[] = [];
  // Width-invariant guards:
  //   - comment prefix: `<4 indent>` + `# ` (2 cols) = 6 cols → budget 94
  //   - cmdLine prefix: `<4 indent>` + `<1 prompt glyph>` + `<1 space>` = 6 cols → budget 94
  // Any example longer than the budget gets truncated to fit; the design
  // system's curated examples in `program.ts` are well under this limit
  // but the guard makes the contract structural rather than caller-
  // discipline-dependent.
  const COMMENT_PREFIX_COLS = ROW_INDENT.length + '# '.length;
  const CMD_PREFIX_COLS = ROW_INDENT.length + 1 + 1;
  for (let i = 0; i < examples.length; i += 1) {
    const ex = examples[i];
    if (ex === undefined) continue;
    const safeComment = truncate(ex.comment, Math.max(0, HELP_MAX_WIDTH - COMMENT_PREFIX_COLS));
    const safeCommand = truncate(ex.command, Math.max(0, HELP_MAX_WIDTH - CMD_PREFIX_COLS));
    const comment = `${ROW_INDENT}${c.muted(`# ${safeComment}`)}`;
    const cmdLine = `${ROW_INDENT}${c.prompt(sym.prompt)} ${c.cmd(safeCommand)}`;
    blocks.push(`${comment}\n${cmdLine}`);
  }
  return [heading, blocks.join('\n\n')].join('\n');
}

function renderSeeAlso(refs: ReadonlyArray<SeeAlsoEntry>): string {
  const heading = `${SECTION_INDENT}${c.head('see also')}`;
  const nameWidth = Math.min(
    refs.reduce((max, r) => Math.max(max, r.command.length), 0),
    38,
  );
  const rows = refs.map((r) => {
    const namePlain = r.command.padEnd(nameWidth);
    const prefix = `${ROW_INDENT}${namePlain}${COL_GAP}`;
    const budget = HELP_MAX_WIDTH - prefix.length;
    const description = truncate(r.description, Math.max(0, budget));
    return `${ROW_INDENT}${c.cmd(namePlain)}${COL_GAP}${c.muted(description)}`;
  });
  return [heading, ...rows].join('\n');
}

function renderFooter(footer: string): string {
  return `${SECTION_INDENT}${c.muted(footer)}`;
}

/**
 * Render the top-level `hivectl --help` screen. The output is a single
 * string with embedded newlines, terminated by a trailing newline so
 * `process.stdout.write` produces a well-formed terminal frame.
 */
export function renderTopLevelHelp(input: TopLevelHelpInput): string {
  const sections: string[] = [
    renderEcho(input.invocation),
    renderTitleBlock(input.programLabel, input.tagline, input.description),
    renderUsage(input.usage),
    ...input.groups.map(renderGroup),
    renderGlobalOptions(input.globalOptions),
    renderFooter(input.footer),
  ];
  return `${sections.join('\n\n')}\n`;
}

/**
 * Render a `hivectl <subgroup> --help` screen. Same shape as the top-
 * level help but with a flat command list and optional `examples` /
 * `see also` blocks. The screen always ends with a trailing newline.
 */
export function renderSubgroupHelp(input: SubgroupHelpInput): string {
  const sections: string[] = [
    renderEcho(input.invocation),
    renderTitleBlock(input.programLabel, input.tagline, input.description),
    renderUsage(input.usage),
    renderFlatCommands(input.commands),
    renderGlobalOptions(input.globalOptions),
  ];
  if (input.examples !== undefined && input.examples.length > 0) {
    sections.push(renderExamples(input.examples));
  }
  if (input.seeAlso !== undefined && input.seeAlso.length > 0) {
    sections.push(renderSeeAlso(input.seeAlso));
  }
  return `${sections.join('\n\n')}\n`;
}
