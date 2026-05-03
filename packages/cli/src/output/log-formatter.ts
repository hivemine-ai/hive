// Inline pretty formatter — SEA-compatible alternative to pino-pretty per
// [[INC-2026-004]] + [[hivectl Output Layer + Status Snapshot]] § Decision:
// custom pino transport vs custom pretty-style formatter.
//
// The formatter is read-only of the JSON line emitted by pino — it never
// mutates pino's pipeline. The server-side logger (`packages/server/src/
// observability/logger.ts`) keeps emitting raw JSON unchanged. The CLI
// wraps the formatter in a DestinationStream wired into `createLogger`
// when `serve` runs in formatted mode (i.e. global `--output` is not
// `json` AND `HIVE_MCP_LOG_PRETTY` is not `false`).
//
// Output shape per the tech spec § Log line shape:
//   hh:mm:ss.mmm␣␣LEVEL␣␣module.path␣␣message␣␣k=v k=v…
// where ␣ is a literal space and segments are joined by 2 spaces.

import { c } from './colors.js';
import type { LevelChipToken } from './colors.js';

export interface FormatPadding {
  /** Width of the module column (chars). Computed at boot via determineModulePathPadding. */
  modulePathWidth: number;
}

const MIN_MODULE_PATH_WIDTH = 18;
const MODULE_PATH_BREATHING_ROOM = 2;
const FALLBACK_MODULE = '-';
const SEGMENT_SEPARATOR = '  ';

// pino numeric levels → fixed-width 5-char chip. Trace collapses to DEBUG
// (single 'verbose' chip — operators don't distinguish trace from debug
// in the CLI surface). Fatal collapses to ERROR (same red, just emitted
// before process exit on the server side).
const PINO_LEVEL_TO_CHIP: ReadonlyMap<number, LevelChipToken> = new Map<number, LevelChipToken>([
  [10, 'DEBUG'],
  [20, 'DEBUG'],
  [30, 'INFO '],
  [40, 'WARN '],
  [50, 'ERROR'],
  [60, 'ERROR'],
]);

// Reserved keys that appear in pino-emitted lines but are NOT k=v extras
// (they live as their own visible columns, or are pino bookkeeping).
const RESERVED_KEYS: ReadonlySet<string> = new Set([
  'level',
  'time',
  'pid',
  'hostname',
  'msg',
  'module',
  'v',
]);

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

function formatTimestamp(timeMs: number): string {
  const d = new Date(timeMs);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
}

function levelToken(level: unknown): LevelChipToken {
  if (typeof level === 'number') {
    const chip = PINO_LEVEL_TO_CHIP.get(level);
    if (chip !== undefined) return chip;
  }
  if (typeof level === 'string') {
    const upper = level.toUpperCase();
    if (upper === 'TRACE' || upper === 'DEBUG') return 'DEBUG';
    if (upper === 'INFO') return 'INFO ';
    if (upper === 'WARN' || upper === 'WARNING') return 'WARN ';
    if (upper === 'ERROR' || upper === 'FATAL') return 'ERROR';
  }
  return 'INFO ';
}

function serialiseValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (value instanceof Error) return value.message;
  return JSON.stringify(value);
}

function formatExtras(line: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of Object.keys(line)) {
    if (RESERVED_KEYS.has(key)) continue;
    parts.push(`${key}=${serialiseValue(line[key])}`);
  }
  return parts.join(' ');
}

/**
 * Format one pino log line into the canonical shape.
 *
 * The function is purely synchronous and does no I/O — callers wrap it in
 * a pino DestinationStream that writes the result to stdout.
 *
 * Missing fields:
 *   - `module` absent or empty  → uses '-' (still padded to maintain column)
 *   - `msg` absent              → empty string (extras only)
 *   - `time` absent             → uses Date.now() at format time
 *   - `level` not numeric/known → defaults to INFO chip (defensive)
 */
export function formatLogLine(line: Record<string, unknown>, padding: FormatPadding): string {
  const time =
    typeof line['time'] === 'number' ? formatTimestamp(line['time']) : formatTimestamp(Date.now());
  const lvl = levelToken(line['level']);
  const moduleRaw =
    typeof line['module'] === 'string' && line['module'].length > 0
      ? line['module']
      : FALLBACK_MODULE;
  const modulePadded = moduleRaw.padEnd(padding.modulePathWidth);
  const msg = typeof line['msg'] === 'string' ? line['msg'] : '';
  const extras = formatExtras(line);

  const segments = [c.muted(time), c.levelChip(lvl), c.muted(modulePadded), msg];
  if (extras.length > 0) segments.push(c.muted(extras));
  return segments.join(SEGMENT_SEPARATOR);
}

/**
 * Compute the module-path column width at boot. Returns
 * `MAX(longest known namespace, 18) + 2` per the tech spec §
 * Decision: Module path padding determined at boot.
 *
 * `knownNamespaces` may be empty — the formula falls back to 18 + 2 = 20
 * so columns stay aligned even when the server emits no `module` field
 * (the current state of `@hive/server`'s logger as of PRY-051; see the
 * PRY § Cambio de scope for the `-` fallback contract).
 */
export function determineModulePathPadding(knownNamespaces: readonly string[]): number {
  let longest = 0;
  for (const ns of knownNamespaces) {
    if (ns.length > longest) longest = ns.length;
  }
  return Math.max(longest, MIN_MODULE_PATH_WIDTH) + MODULE_PATH_BREATHING_ROOM;
}
