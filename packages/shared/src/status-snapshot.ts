// Status snapshot contract shared between server (writer) and CLI (reader),
// per [[ADR-022 - Status snapshot sidecar JSON como cold-start contract
// server-CLI]]. The schema is versioned (`v: 1`); future incompatible
// changes bump `v` and the CLI v1 reader treats unknown versions as
// missing + warn (never break the older reader).
//
// Single canonical home for: the `HiveStatusSnapshot` interface, XDG path
// resolution, the `isStale` policy (`(now - writtenAt) > 2 *
// heartbeatSeconds`), and the `atomicWriteJson` helper used by the server's
// snapshot writer (sync write to `<path>.tmp` + `renameSync` — atomic on
// POSIX and NTFS modern). Imported by `@hive/server` (composition writer)
// and `@hive/cli` (state reader).

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface HiveStatusSnapshot {
  /** Schema version. Bump when fields change incompatibly. */
  v: 1;

  /** ISO 8601 timestamp this snapshot was written. */
  writtenAt: string;

  /** Server's heartbeat interval in seconds. CLI uses this to decide "stale". */
  heartbeatSeconds: number;

  hive: {
    name: string;
    colonies: number;
    keepers: number;
    agents: number;
  } | null;

  server: {
    bind: string;
    pid: number;
    uptimeStartedAt: string;
    version: string;
  } | null;

  database: {
    driver: 'sqlite' | 'postgres';
    location: string;
    sizeBytes?: number;
  };

  lastAudit: {
    at: string;
    event: string;
    actor: string;
  } | null;
}

/**
 * Resolve the canonical sidecar path for the status snapshot. Honours the
 * XDG Base Directory spec (`XDG_STATE_HOME` env var); falls back to
 * `${HOME}/.local/state/hive/status.json` on Linux/Mac. Windows fallback
 * (`%LOCALAPPDATA%/hive/status.json`) is documented in the tech spec but
 * NOT implemented in v0.1 — Windows is a no-target for the OSS release.
 *
 * Reads `process.env` and `os.homedir()` directly. Tests mutate the env in
 * their setup/teardown to exercise both branches.
 */
export function snapshotPath(): string {
  const xdg = process.env['XDG_STATE_HOME'];
  const base = xdg && xdg !== '' ? xdg : join(homedir(), '.local', 'state');
  return join(base, 'hive', 'status.json');
}

/**
 * Decide whether a snapshot is stale. Returns true when more than 2 ×
 * `heartbeatSeconds` have elapsed since `writtenAt`. The threshold lives in
 * the snapshot itself (not in the CLI config) so the CLI does not need to
 * know the server's heartbeat — defensive against config drift.
 *
 * Negative skew (clock adjusted backwards, snapshot from the "future") is
 * treated as fresh — better than crying wolf about a malformed snapshot
 * when the operator just synced their clock.
 *
 * Boundary: exactly 2 × heartbeatSeconds is fresh; > is stale.
 */
export function isStale(snap: HiveStatusSnapshot, now?: number): boolean {
  const nowMs = now ?? Date.now();
  const writtenMs = Date.parse(snap.writtenAt);
  if (Number.isNaN(writtenMs)) return true;
  const elapsedMs = nowMs - writtenMs;
  if (elapsedMs < 0) return false;
  return elapsedMs > snap.heartbeatSeconds * 2 * 1000;
}

/**
 * Atomic JSON write: serialise + write to `<path>.tmp` + rename. The
 * rename is atomic on POSIX (and on NTFS in modern Windows), so a CLI
 * reader can never observe a half-written file. Creates parent
 * directories if missing — the server runs the very first write at boot
 * before any other process has touched the XDG state path on a fresh
 * deployment.
 *
 * Sync on purpose (per the tech spec § "Snapshot atomic write — sync vs
 * async"): the snapshot is < 1KB, the audit chokepoint may fire many
 * times per minute, and async would either await in the hot path (latency
 * hit) or queue (ordering hazard). Pre-measure before optimising; if
 * write latency surfaces in a profile, throttle the writer to 1×/sec
 * (deferred per tech spec — out-of-scope until proven needed).
 */
export function atomicWriteJson(path: string, data: unknown): void {
  const serialised = JSON.stringify(data);
  const tmpPath = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmpPath, serialised, { encoding: 'utf8' });
  renameSync(tmpPath, path);
}
