import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type CommandSummary,
  type OptionSummary,
  type SubgroupHelpInput,
  type TopLevelHelpInput,
  HELP_MAX_WIDTH,
  renderSubgroupHelp,
  renderTopLevelHelp,
  truncate,
} from './help.js';

// Detect ANSI SGR sequences via control char built from charCode (the
// `no-control-regex` ESLint rule flags raw ESC literals).
const ESC = String.fromCharCode(0x1b);
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`);

const previousLevel = chalk.level;

beforeEach(() => {
  // NO_COLOR mode for byte-identical fixtures. Tests that need ANSI bump
  // the level explicitly.
  chalk.level = 0;
});

afterEach(() => {
  chalk.level = previousLevel;
});

// Reusable fixtures matching the live commander setup. These mirror the
// design HTML reference (07c hivectl v3.html § 2 + § 3).

const TOP_LEVEL_INPUT: TopLevelHelpInput = {
  invocation: 'hivectl --help',
  programLabel: 'hivectl',
  tagline: 'admin CLI for Hive',
  description: 'bootstrap, manage participants, issue credentials, query audit log.',
  usage: 'hivectl [options] <command>',
  groups: [
    {
      category: 'server',
      commands: [
        { name: 'init', description: 'bootstrap a fresh Hive — schema, admin keeper, signing key' },
        { name: 'serve', description: 'run the Hive MCP server in the foreground' },
        { name: 'migrate', description: 'manage database schema migrations' },
        { name: 'service', description: 'install / start / stop the Hive system service' },
      ],
    },
    {
      category: 'participants',
      commands: [
        { name: 'hive', description: 'hive-level operations' },
        { name: 'hivekeeper', description: 'hivekeeper lifecycle — create, list' },
        { name: 'agent', description: 'agent lifecycle — create, list, revoke' },
        { name: 'credential', description: 'credential lifecycle — issue, list, rotate, revoke' },
      ],
    },
    {
      category: 'observability',
      commands: [
        { name: 'audit', description: 'query the audit log' },
        { name: 'config', description: 'persistent configuration' },
      ],
    },
  ],
  globalOptions: [
    { flags: '-o, --output <fmt>', description: 'output format: table | json | yaml' },
    { flags: '-y, --yes', description: 'skip confirmation prompts (required for destructive ops)' },
    { flags: '-v, --verbose', description: 'bump log level to debug' },
    { flags: '    --no-color', description: 'disable ANSI colors in output' },
    {
      flags: '    --operator-id <ref>',
      description: 'attribute the audit event to a Hivekeeper (email or UUID v7)',
    },
    { flags: '    --operator-note <t>', description: 'free-form audit note (≤ 256 chars)' },
    { flags: '    --config <path>', description: 'optional .env file with overrides' },
    { flags: '-V, --version', description: 'print the version and exit' },
    { flags: '-h, --help', description: 'display this help' },
  ],
  footer: 'run hivectl <command> --help for command-specific help.',
};

const SERVICE_SUBGROUP_INPUT: SubgroupHelpInput = {
  invocation: 'hivectl service --help',
  programLabel: 'hivectl service',
  tagline: 'manage the Hive system service',
  description: 'delegates to systemd (linux) or launchd (mac). Windows → use Docker.',
  usage: 'hivectl service <command> [options]',
  commands: [
    { name: 'install', args: '[--user|--system]', description: 'write the unit / plist' },
    {
      name: 'uninstall',
      description: 'remove the unit / plist (stops first if active)',
    },
    { name: 'start', description: 'start the service' },
    { name: 'stop', description: 'stop the service' },
    { name: 'restart', description: 'restart the service' },
    {
      name: 'status',
      args: '[--logs N]',
      description: 'uniform service status (exit 0 if running)',
    },
  ],
  globalOptions: [{ flags: '-h, --help', description: 'display this help' }],
  examples: [
    {
      comment: 'first-time install on linux (requires root)',
      command: 'sudo hivectl service install',
    },
    {
      comment: 'quick health check, suitable for shell guards',
      command: 'hivectl service status > /dev/null && echo "running"',
    },
    {
      comment: 'tail the last 50 journal lines',
      command: 'hivectl service status --logs 50',
    },
  ],
  seeAlso: [
    { command: 'hivectl serve', description: 'run in the foreground (no system supervisor)' },
    {
      command: 'hivectl config network',
      description: 'change the bind address before starting the service',
    },
  ],
};

describe('renderTopLevelHelp', () => {
  it('matches the byte-identical NO_COLOR frame against the design reference', () => {
    expect(renderTopLevelHelp(TOP_LEVEL_INPUT)).toBe(
      [
        '⬡ hivectl --help',
        '',
        '  ⬢ hivectl · admin CLI for Hive',
        '    bootstrap, manage participants, issue credentials, query audit log.',
        '',
        '  usage',
        '    hivectl [options] <command>',
        '',
        '  commands · server',
        '    init       bootstrap a fresh Hive — schema, admin keeper, signing key',
        '    serve      run the Hive MCP server in the foreground',
        '    migrate    manage database schema migrations',
        '    service    install / start / stop the Hive system service',
        '',
        '  commands · participants',
        '    hive          hive-level operations',
        '    hivekeeper    hivekeeper lifecycle — create, list',
        '    agent         agent lifecycle — create, list, revoke',
        '    credential    credential lifecycle — issue, list, rotate, revoke',
        '',
        '  commands · observability',
        '    audit     query the audit log',
        '    config    persistent configuration',
        '',
        '  global options',
        '    -o, --output <fmt>          output format: table | json | yaml',
        '    -y, --yes                   skip confirmation prompts (required for destructive ops)',
        '    -v, --verbose               bump log level to debug',
        '        --no-color              disable ANSI colors in output',
        '        --operator-id <ref>     attribute the audit event to a Hivekeeper (email or UUID v7)',
        '        --operator-note <t>     free-form audit note (≤ 256 chars)',
        '        --config <path>         optional .env file with overrides',
        '    -V, --version               print the version and exit',
        '    -h, --help                  display this help',
        '',
        '  run hivectl <command> --help for command-specific help.',
        '',
      ].join('\n'),
    );
  });

  it('keeps every line within HELP_MAX_WIDTH (100 cols)', () => {
    const out = renderTopLevelHelp(TOP_LEVEL_INPUT);
    for (const line of out.split('\n')) {
      expect(line.length, `line over ${HELP_MAX_WIDTH}: ${line}`).toBeLessThanOrEqual(
        HELP_MAX_WIDTH,
      );
    }
  });

  it('emits ANSI sequences when colour is enabled', () => {
    chalk.level = 3;
    const out = renderTopLevelHelp(TOP_LEVEL_INPUT);
    expect(ANSI_RE.test(out)).toBe(true);
    // The "commands · server" heading must travel as a single bold-headed
    // segment (with the muted middle dot) — verify both colour fragments
    // are present.
    expect(out).toContain('commands');
    expect(out).toContain('server');
  });

  it('terminates with a single trailing newline', () => {
    const out = renderTopLevelHelp(TOP_LEVEL_INPUT);
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
  });

  it('preserves command grouping order', () => {
    const out = renderTopLevelHelp(TOP_LEVEL_INPUT);
    const serverPos = out.indexOf('commands · server');
    const participantsPos = out.indexOf('commands · participants');
    const observabilityPos = out.indexOf('commands · observability');
    expect(serverPos).toBeLessThan(participantsPos);
    expect(participantsPos).toBeLessThan(observabilityPos);
  });
});

describe('renderSubgroupHelp', () => {
  it('matches the byte-identical NO_COLOR frame for `service --help` (with examples + see also)', () => {
    expect(renderSubgroupHelp(SERVICE_SUBGROUP_INPUT)).toBe(
      [
        '⬡ hivectl service --help',
        '',
        '  ⬢ hivectl service · manage the Hive system service',
        '    delegates to systemd (linux) or launchd (mac). Windows → use Docker.',
        '',
        '  usage',
        '    hivectl service <command> [options]',
        '',
        '  commands',
        '    install    [--user|--system]  write the unit / plist',
        '    uninstall                     remove the unit / plist (stops first if active)',
        '    start                         start the service',
        '    stop                          stop the service',
        '    restart                       restart the service',
        '    status     [--logs N]         uniform service status (exit 0 if running)',
        '',
        '  global options',
        '    -h, --help     display this help',
        '',
        '  examples',
        '    # first-time install on linux (requires root)',
        '    ⬡ sudo hivectl service install',
        '',
        '    # quick health check, suitable for shell guards',
        '    ⬡ hivectl service status > /dev/null && echo "running"',
        '',
        '    # tail the last 50 journal lines',
        '    ⬡ hivectl service status --logs 50',
        '',
        '  see also',
        '    hivectl serve           run in the foreground (no system supervisor)',
        '    hivectl config network  change the bind address before starting the service',
        '',
      ].join('\n'),
    );
  });

  it('keeps every line within HELP_MAX_WIDTH (100 cols) for `service --help`', () => {
    const out = renderSubgroupHelp(SERVICE_SUBGROUP_INPUT);
    for (const line of out.split('\n')) {
      expect(line.length, `line over ${HELP_MAX_WIDTH}: ${line}`).toBeLessThanOrEqual(
        HELP_MAX_WIDTH,
      );
    }
  });

  it('omits the examples + see also blocks when not provided', () => {
    const minimal: SubgroupHelpInput = {
      invocation: 'hivectl agent --help',
      programLabel: 'hivectl agent',
      tagline: 'agent lifecycle',
      description: 'create, list, and revoke agents under existing Hivekeepers.',
      usage: 'hivectl agent <command> [options]',
      commands: [
        { name: 'create', description: 'create a new Agent under an existing Hivekeeper' },
        { name: 'list', description: 'list Agents in the Hive' },
        { name: 'revoke', description: 'revoke an Agent (cascade-closes its Cell)' },
      ],
      globalOptions: [{ flags: '-h, --help', description: 'display this help' }],
    };
    const out = renderSubgroupHelp(minimal);
    expect(out).not.toContain('examples');
    expect(out).not.toContain('see also');
  });

  it('renders examples block when provided but no see also', () => {
    const partial: SubgroupHelpInput = {
      ...SERVICE_SUBGROUP_INPUT,
    };
    delete (partial as { seeAlso?: unknown }).seeAlso;
    const out = renderSubgroupHelp(partial);
    expect(out).toContain('examples');
    expect(out).not.toContain('see also');
  });

  it('renders see also block when provided but no examples', () => {
    const partial: SubgroupHelpInput = {
      ...SERVICE_SUBGROUP_INPUT,
    };
    delete (partial as { examples?: unknown }).examples;
    const out = renderSubgroupHelp(partial);
    expect(out).toContain('see also');
    expect(out).not.toContain('examples');
  });
});

describe('truncate', () => {
  it('returns the text unchanged when within budget', () => {
    expect(truncate('hello', 10)).toBe('hello');
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('cuts and appends an ellipsis when over budget', () => {
    expect(truncate('hello world', 8)).toBe('hello w…');
  });

  it('returns the empty string when budget is zero or negative', () => {
    expect(truncate('hello', 0)).toBe('');
    expect(truncate('hello', -3)).toBe('');
  });

  it('handles tiny budgets (no room for ellipsis) by raw-cutting', () => {
    expect(truncate('hello', 1)).toBe('h');
  });
});

describe('width invariant under truncation pressure', () => {
  it('truncates an extremely long description so the row stays ≤ HELP_MAX_WIDTH', () => {
    const longDesc = 'x'.repeat(200);
    const huge: ReadonlyArray<CommandSummary> = [{ name: 'init', description: longDesc }];
    const opts: ReadonlyArray<OptionSummary> = [
      { flags: '-h, --help', description: 'display this help' },
    ];
    const input: TopLevelHelpInput = {
      ...TOP_LEVEL_INPUT,
      groups: [{ category: 'server', commands: huge }],
      globalOptions: opts,
    };
    const out = renderTopLevelHelp(input);
    for (const line of out.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(HELP_MAX_WIDTH);
    }
    // Ellipsis must appear since the description is way over budget.
    expect(out).toContain('…');
  });
});
