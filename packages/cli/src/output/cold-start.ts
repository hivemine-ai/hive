// Cold-start renderer for `hivectl` invoked with no subcommand. Pure
// function: takes a snapshot (or null) plus a frozen `now` and returns
// the full multi-line string ready for `process.stdout.write`. No I/O,
// no timers, no network — that contract is what makes the AC of <50ms
// + zero-network mechanically verifiable (per [[ADR-022]] +
// [[hivectl — Operator Experience]] § Cold start).
//
// Three states drive the layout:
//   - `fresh`   — snapshot present and within 2× heartbeat.
//   - `stale`   — snapshot present but beyond 2× heartbeat (server may
//                 be down, or dev paused the daemon).
//   - `missing` — snapshot file absent (fresh install, or operator
//                 wiped XDG state).
//
// The byte-exact frames are anchored against `07c hivectl v3.html` § 1
// "Cold start" — see the cold-start.test.ts NO_COLOR snapshot tests.

import { type HiveStatusSnapshot, isStale, snapshotPath } from '@hive/shared';

import { compact as bannerCompact } from './banner.js';
import { c } from './colors.js';
import { sym } from './symbols.js';

export interface RenderColdStartOptions {
  /** Override `Date.now()` for deterministic tests. */
  now?: number;
  /** Override the snapshot path resolver (used for the fresh subtitle). */
  pathResolver?: () => string;
  /** Override the stale check (mostly for boundary tests). */
  isStaleFn?: (snap: HiveStatusSnapshot, now?: number) => boolean;
}

type State = 'fresh' | 'missing' | 'stale';

const KIB = 1024;
const MIB = KIB * 1024;
const GIB = MIB * 1024;

/**
 * Render an elapsed millisecond delta as a short human-readable
 * duration: sub-minute as `Ns`, sub-hour as `Nm Ms`, sub-day as
 * `Nh Mm`, day-and-up as `Nd`. Negative deltas (clock skew) clamp to
 * `0s` — we'd rather under-report freshness than render "−12s ago".
 */
export function formatRelative(deltaMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(deltaMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours < 24) return `${hours}h ${remMinutes}m`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/**
 * Render a byte count as a binary-prefixed size: B / KiB / MiB / GiB
 * with one decimal place for the prefixed forms. Matches the spirit
 * of the design reference's "14.2 MiB" — close enough that operators
 * recognise the order of magnitude at a glance.
 */
export function formatBytes(n: number): string {
  if (n < KIB) return `${n} B`;
  if (n < MIB) return `${(n / KIB).toFixed(1)} KiB`;
  if (n < GIB) return `${(n / MIB).toFixed(1)} MiB`;
  return `${(n / GIB).toFixed(1)} GiB`;
}

function pluralize(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

function decideState(snap: HiveStatusSnapshot | null, opts: RenderColdStartOptions): State {
  if (snap === null) return 'missing';
  const stale = opts.isStaleFn ?? isStale;
  return stale(snap, opts.now) ? 'stale' : 'fresh';
}

function renderSubtitle(
  state: State,
  snap: HiveStatusSnapshot | null,
  now: number,
  pathResolver: () => string,
): string {
  if (state === 'missing') {
    return c.muted('no snapshot yet');
  }
  if (snap === null) {
    // Defensive — should not happen given decideState, but keeps the
    // type-narrower happy without an `as` cast.
    return c.muted('no snapshot yet');
  }
  const elapsed = now - Date.parse(snap.writtenAt);
  if (state === 'stale') {
    return c.warn(`snapshot ${formatRelative(elapsed)} ago — stale`);
  }
  return c.muted(`snapshot ${formatRelative(elapsed)} ago · ${pathResolver()}`);
}

// Status block label width: every label pads to 11 chars, then 2 plain
// spaces, then the dot column (or content for last-audit). 11 chars is
// the longest label (`last audit `) and accommodates the hive/server/
// database labels with visual breathing room.
const LABEL_WIDTH = 11;
const LABEL_GAP = '  ';

function statusRow(label: string, dot: string | null, content: string): string {
  const paddedLabel = label.padEnd(LABEL_WIDTH);
  if (dot === null) {
    return `    ${c.muted(paddedLabel)}${LABEL_GAP}${c.muted(content)}`;
  }
  return `    ${c.muted(paddedLabel)}${LABEL_GAP}${dot} ${content}`;
}

function renderStatusBlock(state: State, snap: HiveStatusSnapshot | null, now: number): string {
  const header = `  ${c.head('status')}`;

  if (state === 'missing' || snap === null) {
    return [header, `    ${c.warn(sym.dotEmpty)} no hive initialised on this machine.`].join('\n');
  }

  const rows: string[] = [];

  // hive row — name + counts. Stale variant drops `colony` per the
  // 07c v3 reference (shorter line, less visual weight). Plurality
  // depends on the count (`1 keeper` vs `12 keepers`) — the fresh-state
  // byte-identical fixture happens to use values where every count is
  // already plural so a hardcoded plural would pass the snapshot test,
  // but a fresh install (`colonies=1, keepers=1, agents=0`) would render
  // the wrong English ("1 keepers · 0 agents") without `pluralize` above.
  if (snap.hive !== null) {
    const hive = snap.hive;
    const segs: string[] = [c.cmd(hive.name)];
    if (state === 'fresh') {
      segs.push(pluralize(hive.colonies, 'colony', 'colonies'));
    }
    segs.push(pluralize(hive.keepers, 'keeper', 'keepers'));
    segs.push(pluralize(hive.agents, 'agent', 'agents'));
    const content = segs.join(c.muted(' · '));
    rows.push(statusRow('hive', c.ok(sym.dot), content));
  }

  // server row — three flavours. `null` = stopped (graceful shutdown
  // wrote the snapshot with no server section); `stale` = server may
  // be down (last seen too long ago); `fresh` = running.
  if (snap.server === null) {
    rows.push(statusRow('server', c.muted(sym.dotEmpty), c.muted('stopped')));
  } else {
    const elapsed = now - Date.parse(snap.writtenAt);
    const lastSeen = `last seen ${formatRelative(elapsed)} ago`;
    if (state === 'stale') {
      const content = ['stale', snap.server.bind, lastSeen].join(c.muted(' · '));
      rows.push(statusRow('server', c.warn(sym.dot), content));
    } else {
      const content = ['running', snap.server.bind, lastSeen].join(c.muted(' · '));
      rows.push(statusRow('server', c.ok(sym.dot), content));
    }
  }

  // database row — driver + location + (sqlite) size. Stale variant
  // drops the size per the 07c v3 reference.
  const dbSegs: string[] = [snap.database.driver, snap.database.location];
  if (
    state === 'fresh' &&
    snap.database.driver === 'sqlite' &&
    snap.database.sizeBytes !== undefined
  ) {
    dbSegs.push(formatBytes(snap.database.sizeBytes));
  }
  rows.push(statusRow('database', c.ok(sym.dot), dbSegs.join(c.muted(' · '))));

  // last audit row — only when present and only on fresh state.
  if (state === 'fresh' && snap.lastAudit !== null) {
    const elapsed = now - Date.parse(snap.lastAudit.at);
    const content = `${formatRelative(elapsed)} ago — ${snap.lastAudit.event} by ${snap.lastAudit.actor}`;
    rows.push(statusRow('last audit', null, content));
  }

  return [header, ...rows].join('\n');
}

const SECTION_CONFIG: Record<
  State,
  {
    header: string;
    padTrail: number;
    rows: ReadonlyArray<readonly [string, string]>;
  }
> = {
  fresh: {
    header: 'try',
    padTrail: 7,
    rows: [
      ['hivectl serve', 'start the MCP server in foreground'],
      ['hivectl agent list', 'show agents in this hive'],
      ['hivectl audit -n 20', 'tail recent audit events'],
    ],
  },
  missing: {
    header: 'try',
    padTrail: 4,
    rows: [
      ['hivectl init', 'bootstrap a fresh Hive'],
      ['hivectl migrate up', 'apply pending migrations'],
      ['hivectl --help', 'full command tree'],
    ],
  },
  stale: {
    header: 'verify',
    padTrail: 3,
    rows: [
      ['hivectl service status', 'hit the supervisor (real check)'],
      ['hivectl serve', 'start in foreground'],
    ],
  },
};

function renderTryBlock(state: State): string {
  const cfg = SECTION_CONFIG[state];
  const longest = Math.max(...cfg.rows.map(([cmd]) => cmd.length));
  const padTo = longest + cfg.padTrail;
  const header = `  ${c.head(cfg.header)}`;
  const rows = cfg.rows.map(
    ([cmd, desc]) => `    ${c.cmd(cmd.padEnd(padTo))}${c.muted(`  ${desc}`)}`,
  );
  return [header, ...rows].join('\n');
}

function renderHelpHint(): string {
  return `  ${c.muted('run ')}${c.cmd('hivectl --help')}${c.muted(' for the full command tree.')}`;
}

/**
 * Render the cold-start frame end-to-end. Returns a single string that
 * begins with a leading newline (visual breathing room from the shell
 * prompt) and ends with a trailing newline (so `process.stdout.write`
 * leaves the cursor on its own line).
 */
export function renderColdStart(
  snap: HiveStatusSnapshot | null,
  opts: RenderColdStartOptions = {},
): string {
  const state = decideState(snap, opts);
  const now = opts.now ?? Date.now();
  const pathResolver = opts.pathResolver ?? snapshotPath;
  const subtitle = renderSubtitle(state, snap, now, pathResolver);
  const banner = bannerCompact(subtitle);
  const status = renderStatusBlock(state, snap, now);
  const tryBlock = renderTryBlock(state);
  const sections: string[] = ['', banner, '', status, '', tryBlock];
  if (state === 'fresh') {
    sections.push('', renderHelpHint());
  }
  sections.push('');
  return sections.join('\n');
}
