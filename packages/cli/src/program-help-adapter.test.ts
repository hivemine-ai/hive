import { Command } from 'commander';
import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HELP_MAX_WIDTH } from '#output/help.js';
import {
  attachHelpMetadata,
  buildSubgroupHelpInput,
  buildTopLevelHelpInput,
  installHelpOverrides,
} from './program-help-adapter.js';

const previousLevel = chalk.level;

beforeEach(() => {
  chalk.level = 0; // NO_COLOR for byte-stable assertions
});
afterEach(() => {
  chalk.level = previousLevel;
});

/**
 * Build a small fixture commander tree mirroring the real `program.ts`
 * topology: a root with all 10 top-level commands and a `service`
 * subgroup with 6 verbs. Keeps each fixture self-contained so the
 * adapter can be exercised without booting the whole CLI.
 */
function buildFixtureProgram(): Command {
  const program = new Command();
  program
    .name('hivectl')
    .description(
      'Admin CLI for Hive — bootstrap, manage participants, issue credentials, query audit log.',
    )
    .version('0.1.0-dev')
    .option('-o, --output <fmt>', 'output format: table | json | yaml')
    .option('-y, --yes', 'skip confirmation prompts (required for destructive ops)')
    .option('--no-color', 'disable ANSI colors in output')
    .option('-v, --verbose', 'bump log level to debug');

  program.command('init').description('Bootstrap a fresh Hive.');
  program.command('serve').description('Run the MCP server in the foreground.');
  const migrate = program.command('migrate').description('Manage database schema migrations.');
  migrate.command('up').description('Apply all pending migrations.');
  migrate.command('down').description('Roll back the most recent migration.');

  const service = program.command('service').description('Manage the Hive system service.');
  service.command('install').description('Write the unit / plist.');
  service.command('uninstall').description('Remove the unit / plist (stops first if active).');
  service.command('start').description('Start the service.');
  service.command('stop').description('Stop the service.');
  service.command('restart').description('Restart the service.');
  service.command('status').description('Uniform service status (exit 0 if running).');

  const hive = program.command('hive').description('Hive-level operations.');
  hive.command('list-keepers').description('List all Hivekeepers in the Hive.');

  const hivekeeper = program.command('hivekeeper').description('Hivekeeper lifecycle.');
  hivekeeper.command('create').description('Create a new Hivekeeper.');

  const agent = program.command('agent').description('Agent lifecycle.');
  agent.command('create').description('Create a new Agent.');
  agent.command('list').description('List Agents in the Hive.');
  agent.command('revoke').description('Revoke an Agent.');

  const credential = program.command('credential').description('Credential lifecycle.');
  credential.command('issue').description('Issue a new credential.');
  credential.command('list').description('List credentials for a participant.');
  credential.command('rotate').description('Rotate a credential.');
  credential.command('revoke').description('Revoke a credential.');

  const audit = program.command('audit').description('Audit log queries.');
  audit.command('query').description('Query the audit log.');

  const config = program.command('config').description('Persistent configuration.');
  config.command('network').description('Set the network mode.');

  return program;
}

describe('buildTopLevelHelpInput', () => {
  it('produces a complete TopLevelHelpInput with the static groupings', () => {
    const program = buildFixtureProgram();
    const input = buildTopLevelHelpInput(program);

    expect(input.invocation).toBe('hivectl --help');
    expect(input.programLabel).toBe('hivectl');
    expect(input.tagline).toBe('admin CLI for Hive');
    expect(input.usage).toBe('hivectl [options] <command>');
    expect(input.footer).toBe('run hivectl <command> --help for command-specific help.');

    // Three groups in the canonical order.
    expect(input.groups.map((g) => g.category)).toEqual([
      'server',
      'participants',
      'observability',
    ]);

    // Server group lists init / serve / migrate / service in that order.
    const serverNames = input.groups[0]?.commands.map((c) => c.name) ?? [];
    expect(serverNames).toEqual(['init', 'serve', 'migrate', 'service']);

    // Each command has a short summary attached (not the commander
    // long-form description).
    const init = input.groups[0]?.commands[0];
    expect(init?.description).toContain('bootstrap');

    // Global options surfaced through the adapter, including the
    // implicit `-h, --help`.
    const flags = input.globalOptions.map((o) => o.flags);
    expect(flags).toContain('-h, --help');
  });

  it('throws when a registered top-level command is missing from TOP_LEVEL_GROUPS', () => {
    const program = buildFixtureProgram();
    program.command('orphan').description('An orphan command.');
    expect(() => buildTopLevelHelpInput(program)).toThrow(/orphan/i);
  });

  it('throws when TOP_LEVEL_GROUPS lists a command that is not registered', () => {
    const program = new Command();
    program.name('hivectl').version('0.1.0-dev');
    // Only register `init`; the adapter expects the full set.
    program.command('init').description('Bootstrap.');
    expect(() => buildTopLevelHelpInput(program)).toThrow(/serve.*not registered/);
  });
});

describe('buildSubgroupHelpInput', () => {
  it('extracts commands and options from a commander subgroup', () => {
    const program = buildFixtureProgram();
    const service = program.commands.find((c) => c.name() === 'service');
    if (service === undefined) throw new Error('test setup error: service command missing');

    const input = buildSubgroupHelpInput(service);

    expect(input.invocation).toBe('hivectl service --help');
    expect(input.programLabel).toBe('hivectl service');
    expect(input.usage).toBe('hivectl service <command> [options]');

    expect(input.commands.map((c) => c.name)).toEqual([
      'install',
      'uninstall',
      'start',
      'stop',
      'restart',
      'status',
    ]);

    // Implicit help option is appended even when the fixture did not
    // explicitly register one on the subgroup.
    expect(input.globalOptions.some((o) => o.flags.includes('--help'))).toBe(true);
  });

  it('uses attached metadata when provided (tagline / description / examples / seeAlso)', () => {
    const program = buildFixtureProgram();
    const service = program.commands.find((c) => c.name() === 'service');
    if (service === undefined) throw new Error('test setup error: service command missing');

    attachHelpMetadata(service, {
      tagline: 'manage the Hive system service',
      description: 'delegates to systemd (linux) or launchd (mac).',
      examples: [{ comment: 'first install', command: 'sudo hivectl service install' }],
      seeAlso: [{ command: 'hivectl serve', description: 'run in the foreground' }],
    });

    const input = buildSubgroupHelpInput(service);
    expect(input.tagline).toBe('manage the Hive system service');
    expect(input.description).toContain('systemd');
    expect(input.examples).toHaveLength(1);
    expect(input.seeAlso).toHaveLength(1);
  });

  it('derives a tagline from the commander description when no metadata is attached', () => {
    const program = buildFixtureProgram();
    const agent = program.commands.find((c) => c.name() === 'agent');
    if (agent === undefined) throw new Error('test setup error: agent command missing');

    const input = buildSubgroupHelpInput(agent);
    // Commander description: "Agent lifecycle." — tagline should drop
    // the trailing period.
    expect(input.tagline).toBe('Agent lifecycle');
  });
});

describe('installHelpOverrides', () => {
  it('replaces helpInformation() on root and on every subgroup', () => {
    const program = buildFixtureProgram();
    installHelpOverrides(program);

    const rootHelp = program.helpInformation();
    expect(rootHelp).toContain('⬡ hivectl --help');
    expect(rootHelp).toContain('commands · server');
    expect(rootHelp).toContain('global options');

    const service = program.commands.find((c) => c.name() === 'service');
    if (service === undefined) throw new Error('test setup error: service command missing');
    const serviceHelp = service.helpInformation();
    expect(serviceHelp).toContain('⬡ hivectl service --help');
    expect(serviceHelp).toContain('commands');
  });

  it('does NOT override leaf commands (commands with no children)', () => {
    const program = buildFixtureProgram();
    installHelpOverrides(program);

    const init = program.commands.find((c) => c.name() === 'init');
    if (init === undefined) throw new Error('test setup error: init command missing');
    // The override would render "⬡ hivectl init --help" — commander's
    // default never contains the prompt glyph at the start.
    const initHelp = init.helpInformation();
    expect(initHelp.startsWith('⬡')).toBe(false);
  });

  it('keeps every line of the rendered top-level help within HELP_MAX_WIDTH', () => {
    const program = buildFixtureProgram();
    installHelpOverrides(program);
    const out = program.helpInformation();
    for (const line of out.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(HELP_MAX_WIDTH);
    }
  });

  it('keeps every line of every subgroup help within HELP_MAX_WIDTH', () => {
    const program = buildFixtureProgram();
    installHelpOverrides(program);
    for (const sub of program.commands) {
      if (sub.commands.length === 0) continue; // leaf
      const out = sub.helpInformation();
      for (const line of out.split('\n')) {
        expect(
          line.length,
          `line over ${HELP_MAX_WIDTH} in ${sub.name()}: ${line}`,
        ).toBeLessThanOrEqual(HELP_MAX_WIDTH);
      }
    }
  });
});
