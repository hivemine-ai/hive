// CLI-side reader for the status snapshot sidecar JSON written by the
// server (per [[ADR-022]]). The Slice 2 cold-start handler (PRY-049) will
// invoke `readSnapshot()` to render the status block in <50ms zero-network.
//
// Failure-mode contract (per the tech spec § Slice 1):
//   - File missing (ENOENT)        → return null + (NO warn — clean state)
//   - Read error (other I/O)       → return null + warn to stderr
//   - JSON.parse error              → return null + warn to stderr
//   - Schema version mismatch (v != 1) → return null + warn to stderr
//
// Never throws. The cold-start handler treats `null` as "missing snapshot,
// render the no-state variant".

import { readFile } from 'node:fs/promises';

import { type HiveStatusSnapshot, snapshotPath as defaultSnapshotPath } from '@hive/shared';

export interface ReadSnapshotOptions {
  /** Override the path resolver (test injection). Defaults to `snapshotPath()`. */
  pathResolver?: () => string;
  /**
   * Override the warn sink. Defaults to writing one line to stderr — the
   * canonical sink for CLI tooling that should not pollute stdout (operator
   * may pipe stdout to JSON parsers / scripts).
   */
  warn?: (line: string) => void;
}

function defaultWarn(line: string): void {
  process.stderr.write(`${line}\n`);
}

interface NodeIoError extends Error {
  code?: string;
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && (err as NodeIoError).code === 'ENOENT';
}

function looksLikeSnapshot(value: unknown): value is HiveStatusSnapshot {
  if (value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return (
    obj['v'] === 1 &&
    typeof obj['writtenAt'] === 'string' &&
    typeof obj['heartbeatSeconds'] === 'number' &&
    'hive' in obj &&
    'server' in obj &&
    'database' in obj &&
    'lastAudit' in obj
  );
}

/**
 * Read the status snapshot from disk. Never throws. Returns null when the
 * file is missing, unreadable, malformed, or carries an incompatible
 * schema version. Logs a warn to stderr in the latter three cases (ENOENT
 * is a clean state — no warn).
 *
 * Used by the CLI cold start (Slice 2 — PRY-049) and by any future read-only
 * consumer (healthcheck script, prometheus exporter, etc.).
 */
export async function readSnapshot(
  opts: ReadSnapshotOptions = {},
): Promise<HiveStatusSnapshot | null> {
  const path = (opts.pathResolver ?? defaultSnapshotPath)();
  const warn = opts.warn ?? defaultWarn;

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (isEnoent(err)) return null;
    warn(
      `hive: warning: failed to read status snapshot at ${path}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    warn(
      `hive: warning: status snapshot at ${path} is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }

  if (!looksLikeSnapshot(parsed)) {
    const version =
      parsed !== null && typeof parsed === 'object' && 'v' in parsed ? parsed.v : '<missing>';
    warn(
      `hive: warning: status snapshot at ${path} has unsupported schema version (v=${String(version)}); expected v=1. Treating as missing.`,
    );
    return null;
  }

  return parsed;
}
