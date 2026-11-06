// The PID map (`state/pid-map/<claudePid>.json`, written by the SessionStart hook)
// and the proxy entries (`state/proxies/<claudePid>.json`, written by the proxy).
// Each entry carries the start time of the `claude` process: an entry whose start
// time no longer matches (reused PID) or whose process is gone is an orphan and
// is ignored.

import { spawnSync } from 'node:child_process';

import { readPrivateJson, removePrivateFile, writePrivateJson } from './state-dir.js';
import type { StatePaths } from './state-dir.js';

export type StartTimeOf = (pid: number) => string | undefined;

/** Start time of a process as `ps -o lstart=` prints it, or undefined if it is gone. */
export function processStartTime(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  });
  if (result.status !== 0) return undefined;
  const text = result.stdout.trim();
  return text === '' ? undefined : text;
}

export interface PidMapEntry {
  claudePid: number;
  claudeStartTime: string;
  sessionId: string;
  source: string;
  /** Name saved for the session id, if any. */
  name?: string;
  /** Description saved with the name, if any (written by the hook of PRY-093). */
  description?: string;
}

function str(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function parsePidMapEntry(raw: unknown, pid: number): PidMapEntry | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (r['claudePid'] !== pid || !str(r['claudeStartTime'])) return undefined;
  if (!str(r['sessionId']) || !str(r['source'])) return undefined;
  const entry: PidMapEntry = {
    claudePid: pid,
    claudeStartTime: r['claudeStartTime'],
    sessionId: r['sessionId'],
    source: r['source'],
  };
  if (str(r['name'])) entry.name = r['name'];
  if (str(r['description'])) entry.description = r['description'];
  return entry;
}

export function readPidMapEntry(
  paths: StatePaths,
  claudePid: number,
  startTimeOf: StartTimeOf = processStartTime,
): PidMapEntry | undefined {
  const entry = parsePidMapEntry(readPrivateJson(paths.pidMap(claudePid)), claudePid);
  if (entry === undefined) return undefined;
  return startTimeOf(claudePid) === entry.claudeStartTime ? entry : undefined;
}

export interface ProxyEntry {
  claudePid: number;
  claudeStartTime: string;
  proxyHandle: string;
  socketPath: string;
  registered: boolean;
  name?: string;
}

export function publishProxyEntry(paths: StatePaths, entry: ProxyEntry): void {
  writePrivateJson(paths.proxy(entry.claudePid), entry);
}

export function removeProxyEntry(paths: StatePaths, claudePid: number): void {
  removePrivateFile(paths.proxy(claudePid));
}

export function readLiveProxyEntry(
  paths: StatePaths,
  claudePid: number,
  startTimeOf: StartTimeOf = processStartTime,
): ProxyEntry | undefined {
  const raw = readPrivateJson(paths.proxy(claudePid));
  if (raw === null || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (r['claudePid'] !== claudePid || !str(r['claudeStartTime'])) return undefined;
  if (!str(r['proxyHandle']) || !str(r['socketPath']) || typeof r['registered'] !== 'boolean') {
    return undefined;
  }
  if (startTimeOf(claudePid) !== r['claudeStartTime']) return undefined;
  const entry: ProxyEntry = {
    claudePid,
    claudeStartTime: r['claudeStartTime'],
    proxyHandle: r['proxyHandle'],
    socketPath: r['socketPath'],
    registered: r['registered'],
  };
  if (str(r['name'])) entry.name = r['name'];
  return entry;
}
