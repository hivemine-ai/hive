// Adapter from commander's `Command` API to the structured-data inputs
// of `output/help.ts`. Lives outside `program.ts` so the renderer can be
// driven from anywhere (tests, future CLI variants) without dragging
// the full commander tree along.
//
// The grouping decisions for the top-level help (server / participants /
// observability) are encoded here as a static lookup. Adding a new
// top-level subcommand requires:
//   1. Wiring it on `program` in `program.ts`.
//   2. Listing it in `TOP_LEVEL_GROUPS` below under the right category.
//      An unlisted command surfaces as a thrown error from
//      `buildTopLevelHelpInput` so accidentally orphaning a command
//      fails loudly at the first `--help` invocation rather than going
//      quietly missing.
//
// Subgroup help comes through with a flat command list; the metadata
// for `examples` and `see also` is attached at registration time via
// `attachHelpMetadata` (a `WeakMap`-based side channel — keeps the
// commander prototype clean and avoids monkey-patching).

import type { Command } from 'commander';

import {
  type CommandSummary,
  type ExampleEntry,
  type OptionSummary,
  type SeeAlsoEntry,
  type SubgroupHelpInput,
  type TopLevelHelpInput,
  renderSubgroupHelp,
  renderTopLevelHelp,
} from '#output/help.js';

interface HelpMetadata {
  /** Tagline shown after the title `·`. Falls back to first line of `description()`. */
  tagline?: string;
  /** Multi-word description shown indented below the title. */
  description?: string;
  /** Optional examples block. */
  examples?: ReadonlyArray<ExampleEntry>;
  /** Optional cross-reference block. */
  seeAlso?: ReadonlyArray<SeeAlsoEntry>;
}

const helpMetadataStore = new WeakMap<Command, HelpMetadata>();

/**
 * Attach optional help metadata (tagline override, description override,
 * examples, see-also) to a commander `Command`. Keeps the metadata off
 * the commander prototype so the integration is non-invasive.
 *
 * Idempotent: a second call replaces the stored metadata wholesale.
 */
export function attachHelpMetadata(command: Command, metadata: HelpMetadata): void {
  helpMetadataStore.set(command, metadata);
}

/**
 * Static grouping of top-level subcommands. Order within each group is
 * the display order. The category labels appear in the heading as
 * `commands · <category>`. An unlisted command throws — see the file
 * docstring above.
 */
const TOP_LEVEL_GROUPS: ReadonlyArray<{ category: string; commands: ReadonlyArray<string> }> = [
  { category: 'server', commands: ['init', 'serve', 'migrate', 'service'] },
  { category: 'participants', commands: ['hive', 'hivekeeper', 'agent', 'credential'] },
  { category: 'observability', commands: ['audit', 'config'] },
];

/**
 * One-line description shown to the right of each top-level command name.
 * Overrides the commander `description()` (which can be multi-sentence
 * for `--help <subcommand>` purposes). Keeping these short here keeps
 * the top-level help scannable.
 */
const TOP_LEVEL_SUMMARIES: Readonly<Record<string, string>> = {
  init: 'bootstrap a fresh Hive — schema, admin keeper, signing key',
  serve: 'run the Hive MCP server in the foreground',
  migrate: 'manage database schema migrations',
  service: 'install / start / stop the Hive system service',
  hive: 'hive-level operations',
  hivekeeper: 'hivekeeper lifecycle — create, list',
  agent: 'agent lifecycle — create, list, revoke',
  credential: 'credential lifecycle — issue, list, rotate, revoke',
  audit: 'query the audit log',
  config: 'persistent configuration',
};

const TOP_LEVEL_DESCRIPTION = 'bootstrap, manage participants, issue credentials, query audit log.';

const TOP_LEVEL_TAGLINE = 'admin CLI for Hive';

const TOP_LEVEL_FOOTER = 'run hivectl <command> --help for command-specific help.';

/**
 * Translate commander option flags + description into the structured
 * shape the renderer expects. Commander stores aliasless options with
 * leading whitespace under `flags` already (e.g. `--no-color` is
 * `--no-color` without `-X,`); we left-pad those that have NO short
 * alias so they align visually with their alias-prefixed siblings —
 * mirroring the design HTML reference (07c hivectl v3.html § 2 global
 * options block).
 */
function summariseOption(flagsRaw: string, descriptionRaw: string): OptionSummary {
  const flags =
    flagsRaw.startsWith('-') && !/^-[a-zA-Z],/.test(flagsRaw) ? `    ${flagsRaw}` : flagsRaw;
  return { flags, description: descriptionRaw };
}

function extractGlobalOptions(program: Command): ReadonlyArray<OptionSummary> {
  const opts: OptionSummary[] = [];
  for (const opt of program.options) {
    opts.push(summariseOption(opt.flags, opt.description ?? ''));
  }
  // Commander auto-adds `-V, --version` and `-h, --help` only on
  // request via `version()` and `helpOption()`. The first is set in
  // `program.ts`; the second is on by default. We append the help
  // option explicitly so it shows even when the program does not
  // expose it via `program.options`.
  if (!opts.some((o) => o.flags.includes('--help'))) {
    opts.push({ flags: '-h, --help', description: 'display this help' });
  }
  return opts;
}

/**
 * Build the structured input for `renderTopLevelHelp`. The static
 * groupings and per-command summary overrides keep the output tightly
 * aligned with the design reference even when commander's per-command
 * descriptions evolve.
 *
 * Throws if a registered top-level command is missing from
 * `TOP_LEVEL_GROUPS` — that is a wiring bug, not a runtime concern.
 */
export function buildTopLevelHelpInput(program: Command): TopLevelHelpInput {
  const registered = new Set<string>();
  for (const sub of program.commands) {
    registered.add(sub.name());
  }

  const groups = TOP_LEVEL_GROUPS.map((group) => {
    const commands: CommandSummary[] = [];
    for (const cmdName of group.commands) {
      if (!registered.has(cmdName)) {
        throw new Error(
          `top-level command "${cmdName}" is listed in TOP_LEVEL_GROUPS but not registered ` +
            'on the program. Either register it in program.ts or remove the entry from ' +
            'TOP_LEVEL_GROUPS in program-help-adapter.ts.',
        );
      }
      const description = TOP_LEVEL_SUMMARIES[cmdName] ?? '';
      commands.push({ name: cmdName, description });
    }
    return { category: group.category, commands };
  });

  // Validate that every registered command appears in some group.
  const grouped = new Set(TOP_LEVEL_GROUPS.flatMap((g) => g.commands));
  for (const sub of program.commands) {
    const name = sub.name();
    if (!grouped.has(name)) {
      throw new Error(
        `top-level command "${name}" is registered on the program but missing from ` +
          'TOP_LEVEL_GROUPS in program-help-adapter.ts. Add it to the right category.',
      );
    }
  }

  return {
    invocation: 'hivectl --help',
    programLabel: 'hivectl',
    tagline: TOP_LEVEL_TAGLINE,
    description: TOP_LEVEL_DESCRIPTION,
    usage: 'hivectl [options] <command>',
    groups,
    globalOptions: extractGlobalOptions(program),
    footer: TOP_LEVEL_FOOTER,
  };
}

/**
 * Build the structured input for `renderSubgroupHelp` from a commander
 * subgroup `Command`. The tagline + description fall back to the
 * commander `description()` when no explicit metadata is attached;
 * examples + see-also come from `attachHelpMetadata` if present.
 */
export function buildSubgroupHelpInput(
  command: Command,
  parentLabel = 'hivectl',
): SubgroupHelpInput {
  const metadata = helpMetadataStore.get(command);
  const cmdName = command.name();
  const fullLabel = `${parentLabel} ${cmdName}`;
  const description = metadata?.description ?? command.description() ?? '';
  const tagline = metadata?.tagline ?? deriveTaglineFromDescription(description);
  const usage = `${fullLabel} <command> [options]`;

  const commands: CommandSummary[] = command.commands.map((sub) => {
    const args = formatSubcommandArgs(sub);
    const summary: CommandSummary = {
      name: sub.name(),
      description: sub.description() ?? '',
    };
    if (args.length > 0) summary.args = args;
    return summary;
  });

  const subgroupOptions: OptionSummary[] = command.options.map((o) =>
    summariseOption(o.flags, o.description ?? ''),
  );
  if (!subgroupOptions.some((o) => o.flags.includes('--help'))) {
    subgroupOptions.push({ flags: '-h, --help', description: 'display this help' });
  }

  const result: SubgroupHelpInput = {
    invocation: `${fullLabel} --help`,
    programLabel: fullLabel,
    tagline,
    description,
    usage,
    commands,
    globalOptions: subgroupOptions,
  };
  if (metadata?.examples !== undefined && metadata.examples.length > 0) {
    result.examples = metadata.examples;
  }
  if (metadata?.seeAlso !== undefined && metadata.seeAlso.length > 0) {
    result.seeAlso = metadata.seeAlso;
  }
  return result;
}

/**
 * Extract the inline argument cluster from a commander subcommand,
 * e.g. `[--user|--system]` shown next to `install` in `hivectl service
 * --help`. **Currently always returns the empty string.**
 *
 * The renderer (`output/help.ts`) supports a per-row `args` field on
 * `CommandSummary` and the byte-identical fixture in `help.test.ts`
 * exercises it, but the integration path (adapter → renderer) does NOT
 * surface inline args today. `HelpMetadata` has no `args` field and
 * commander does not expose a clean primitive for the operator-facing
 * arg cluster (its `Argument` API targets positional-arg parsing, not
 * help-screen display strings). The PR-50 design HTML reference shows
 * `[--user|--system]` next to `service install`; that bit of polish is
 * deliberately deferred — closing it cleanly requires extending
 * `HelpMetadata` with a `verbArgs?: Record<string, string>` map and
 * threading it through this helper. Tracked as a follow-up nice-to-have
 * in PRY-050 § Nice-to-have diferidos.
 *
 * The empty return preserves the current adapter signature uniformly
 * across all subcommands so no caller branches on its presence.
 */
function formatSubcommandArgs(_sub: Command): string {
  return '';
}

/**
 * Derive a short tagline from a multi-sentence description by taking
 * the first sentence (up to the first `.`, `—`, or `\n`). Used when
 * the caller did not attach explicit help metadata and commander's
 * description is long-form.
 */
function deriveTaglineFromDescription(description: string): string {
  const stop = description.search(/[.\n—]/);
  if (stop === -1) return description.trim();
  return description.slice(0, stop).trim();
}

/**
 * Install the renderer as commander's `helpInformation()` override on
 * the root program and on every subgroup `Command`. After this call,
 * `program.help()` and any `<subgroup> --help` invocation render via
 * `output/help.ts` instead of commander's default.
 *
 * Leaf commands (concrete actions like `agent create`, `credential
 * issue`, etc.) keep commander's default help — they take per-flag
 * options that the bespoke renderer is not specialised for. PRY-052+
 * may extend the design system to those if the design pulls them in.
 */
export function installHelpOverrides(program: Command): void {
  program.helpInformation = function rootHelp(): string {
    return renderTopLevelHelp(buildTopLevelHelpInput(program));
  };
  for (const sub of program.commands) {
    if (sub.commands.length === 0) continue; // leaf — keep default help
    sub.helpInformation = function subgroupHelp(): string {
      return renderSubgroupHelp(buildSubgroupHelpInput(sub));
    };
  }
}
