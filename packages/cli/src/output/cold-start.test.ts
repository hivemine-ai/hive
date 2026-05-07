import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HIVE_VERSION, type HiveStatusSnapshot } from '@hive/shared';

import { formatBytes, formatRelative, renderColdStart } from './cold-start.js';

const VLABEL = `v${HIVE_VERSION}`;

// Anchor `now` so age-derived strings ("12s ago", "4m 12s ago") are
// deterministic across runs. The snapshot fixtures below set `writtenAt`
// at fixed deltas from this anchor.
const NOW_MS = Date.parse('2026-05-03T14:02:31.000Z');

function freshSnapshot(): HiveStatusSnapshot {
  return {
    v: 1,
    writtenAt: new Date(NOW_MS - 12_000).toISOString(),
    heartbeatSeconds: 60,
    hive: { name: 'test-hive', colonies: 1, keepers: 4, agents: 12 },
    server: {
      bind: '127.0.0.1:7700',
      pid: 41822,
      uptimeStartedAt: new Date(NOW_MS - 3_600_000).toISOString(),
      version: '0.1.0',
    },
    database: {
      driver: 'sqlite',
      location: './var/db/hive.sqlite',
      sizeBytes: 14_889_779, // ≈ 14.2 MiB
    },
    lastAudit: {
      at: new Date(NOW_MS - 12_000).toISOString(),
      event: 'credential.issued',
      actor: 'braindaamage',
    },
  };
}

function staleSnapshot(): HiveStatusSnapshot {
  // 4m 12s = 252s old. heartbeat=60s → stale boundary is 120s, so this
  // is well past stale.
  return {
    v: 1,
    writtenAt: new Date(NOW_MS - 252_000).toISOString(),
    heartbeatSeconds: 60,
    hive: { name: 'test-hive', colonies: 1, keepers: 4, agents: 12 },
    server: {
      bind: '127.0.0.1:7700',
      pid: 41822,
      uptimeStartedAt: new Date(NOW_MS - 3_600_000).toISOString(),
      version: '0.1.0',
    },
    database: {
      driver: 'sqlite',
      location: './var/db/hive.sqlite',
      sizeBytes: 14_889_779,
    },
    lastAudit: {
      at: new Date(NOW_MS - 252_000).toISOString(),
      event: 'credential.issued',
      actor: 'braindaamage',
    },
  };
}

describe('formatRelative', () => {
  it('renders sub-minute as "Ns"', () => {
    expect(formatRelative(0)).toBe('0s');
    expect(formatRelative(999)).toBe('0s');
    expect(formatRelative(12_000)).toBe('12s');
    expect(formatRelative(59_999)).toBe('59s');
  });

  it('renders minutes as "Nm Ms"', () => {
    expect(formatRelative(60_000)).toBe('1m 0s');
    expect(formatRelative(252_000)).toBe('4m 12s');
    expect(formatRelative(3_599_000)).toBe('59m 59s');
  });

  it('renders hours as "Nh Mm"', () => {
    expect(formatRelative(3_600_000)).toBe('1h 0m');
    expect(formatRelative(7_320_000)).toBe('2h 2m');
  });

  it('renders days as "Nd"', () => {
    expect(formatRelative(86_400_000)).toBe('1d');
    expect(formatRelative(259_200_000)).toBe('3d');
  });

  it('clamps negative deltas to "0s" (clock skew tolerance)', () => {
    expect(formatRelative(-5_000)).toBe('0s');
  });
});

describe('formatBytes', () => {
  it('renders sub-KiB as plain bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('renders KiB / MiB / GiB with one decimal', () => {
    expect(formatBytes(1024)).toBe('1.0 KiB');
    expect(formatBytes(1_536)).toBe('1.5 KiB');
    expect(formatBytes(14_889_779)).toBe('14.2 MiB');
    expect(formatBytes(1_073_741_824)).toBe('1.0 GiB');
  });
});

describe('renderColdStart', () => {
  const previousLevel = chalk.level;
  beforeEach(() => {
    // NO_COLOR mode keeps the byte assertions deterministic. Tests that
    // need to verify ANSI presence flip the level themselves.
    chalk.level = 0;
  });
  afterEach(() => {
    chalk.level = previousLevel;
  });

  it('renders the FRESH frame byte-identical against the design reference', () => {
    // Mirrors `07c hivectl v3.html` § "1 · Cold start" main frame, with
    // the example hive name swapped from the legacy "cotalker" fixture
    // to the neutral "test-hive" used since PRY-053. Path field uses
    // an explicit pathResolver so the test does not depend on $HOME.
    const out = renderColdStart(freshSnapshot(), {
      now: NOW_MS,
      pathResolver: () => '~/.local/state/hive/status.json',
    });
    const expected = [
      '',
      `    ⬢ ⬢ ⬢    hivectl  ·  ${VLABEL}  ·  apache-2.0`,
      '  ⬢ ⬢ ⬢ ⬢ ⬢  open-source MCP server for collaborative AI agents',
      '    ⬢ ⬢ ⬢    snapshot 12s ago · ~/.local/state/hive/status.json',
      '',
      '  status',
      '    hive         ● test-hive · 1 colony · 4 keepers · 12 agents',
      '    server       ● running · 127.0.0.1:7700 · last seen 12s ago',
      '    database     ● sqlite · ./var/db/hive.sqlite · 14.2 MiB',
      '    last audit   12s ago — credential.issued by braindaamage',
      '',
      '  try',
      '    hivectl serve               start the MCP server in foreground',
      '    hivectl agent list          show agents in this hive',
      '    hivectl audit -n 20         tail recent audit events',
      '',
      '  run hivectl --help for the full command tree.',
      '',
    ].join('\n');
    expect(out).toBe(expected);
  });

  it('renders the MISSING frame byte-identical (snapshot is null)', () => {
    const out = renderColdStart(null, { now: NOW_MS });
    const expected = [
      '',
      `    ⬢ ⬢ ⬢    hivectl  ·  ${VLABEL}  ·  apache-2.0`,
      '  ⬢ ⬢ ⬢ ⬢ ⬢  open-source MCP server for collaborative AI agents',
      '    ⬢ ⬢ ⬢    no snapshot yet',
      '',
      '  status',
      '    ○ no hive initialised on this machine.',
      '',
      '  try',
      '    hivectl init            bootstrap a fresh Hive',
      '    hivectl migrate up      apply pending migrations',
      '    hivectl --help          full command tree',
      '',
    ].join('\n');
    expect(out).toBe(expected);
  });

  it('renders the STALE frame byte-identical (snapshot older than 2× heartbeat)', () => {
    const out = renderColdStart(staleSnapshot(), { now: NOW_MS });
    const expected = [
      '',
      `    ⬢ ⬢ ⬢    hivectl  ·  ${VLABEL}  ·  apache-2.0`,
      '  ⬢ ⬢ ⬢ ⬢ ⬢  open-source MCP server for collaborative AI agents',
      '    ⬢ ⬢ ⬢    snapshot 4m 12s ago — stale',
      '',
      '  status',
      '    hive         ● test-hive · 4 keepers · 12 agents',
      '    server       ● stale · 127.0.0.1:7700 · last seen 4m 12s ago',
      '    database     ● sqlite · ./var/db/hive.sqlite',
      '',
      '  verify',
      '    hivectl service status     hit the supervisor (real check)',
      '    hivectl serve              start in foreground',
      '',
    ].join('\n');
    expect(out).toBe(expected);
  });

  it('emits ANSI sequences when colour is enabled (smoke check)', () => {
    chalk.level = 3;
    const ESC = String.fromCharCode(0x1b);
    const out = renderColdStart(freshSnapshot(), {
      now: NOW_MS,
      pathResolver: () => '~/.local/state/hive/status.json',
    });
    expect(out).toContain(`${ESC}[`); // any SGR sequence
    // The status block dot fires `c.ok` for fresh — different from `c.muted`.
    expect(out.includes('●')).toBe(true);
  });

  it('pluralizes counts correctly on the fresh-install edge case (1 keeper, 0 agents, 1 colony)', () => {
    // Regression for S1 of code-reviewer Fase 5: the fresh-state
    // byte-identical fixture happens to use plural-only values
    // (keepers=4, agents=12, colonies=1 with the "colony" word
    // matching anyway). A fresh install renders singular keeper +
    // zero-plural agents — without `pluralize` the line read "1
    // keepers · 0 agents".
    const snap: HiveStatusSnapshot = {
      ...freshSnapshot(),
      hive: { name: 'test-hive', colonies: 1, keepers: 1, agents: 0 },
    };
    const out = renderColdStart(snap, {
      now: NOW_MS,
      pathResolver: () => '~/.local/state/hive/status.json',
    });
    expect(out).toContain('1 colony');
    expect(out).toContain('1 keeper');
    expect(out).not.toContain('1 keepers');
    expect(out).toContain('0 agents');
  });

  it('treats a missing lastAudit field as "no last audit row" (defensive)', () => {
    const snap = { ...freshSnapshot(), lastAudit: null };
    const out = renderColdStart(snap, {
      now: NOW_MS,
      pathResolver: () => '~/.local/state/hive/status.json',
    });
    // Status block still renders, just without the last-audit line.
    expect(out).toContain('  status');
    expect(out).not.toContain('last audit');
  });

  it('treats a missing server field as "stale-style server row" (server crashed)', () => {
    const snap = { ...freshSnapshot(), server: null };
    const out = renderColdStart(snap, {
      now: NOW_MS,
      pathResolver: () => '~/.local/state/hive/status.json',
    });
    // Server row replaced with the off variant per the product spec
    // "no running server" sub-case (rendered as `stopped` not `running`).
    expect(out).toContain('server');
    expect(out).toContain('stopped');
  });
});
