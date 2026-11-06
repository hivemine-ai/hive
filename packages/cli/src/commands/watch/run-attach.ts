// `hivectl watch --attach-session <session_id> [--once]` (ADR-026 3.a, tech spec
// § "watch: modo harness", variant `--attach-session`). Launched by the hive-wake
// mod of an interactive session. It holds no credential, registers nothing and
// opens no stream: it reads the event lines of the session's single stream from
// the proxy's local channel.
//
// Resolution: session_id → PID-map entry with that session id → claudePid →
// proxies/<claudePid>.json → socketPath (both entries validated by the start time
// of the `claude` process). While the session is not registered it waits; when
// the channel goes away (proxy dead, or reconnected by hand with another handle)
// it resolves it again instead of ending.

import { readdirSync } from 'node:fs';
import * as net from 'node:net';

import { abortableSleep, backoffDelay, serializeEventLine } from '@hive/client';
import type { BackoffOptions, WatchEvent } from '@hive/client';

import { EXIT_INTERRUPTED, EXIT_OK } from '#error/exit-codes.js';
import { processStartTime, readLiveProxyEntry, readPidMapEntry } from '#session/pid-map.js';
import type { ProxyEntry, StartTimeOf } from '#session/pid-map.js';
import { configRoot, statePaths } from '#session/state-dir.js';
import type { StatePaths } from '#session/state-dir.js';

import { WatchError } from './errors.js';
import type { WatchIo } from './io.js';
import type { AttachInput } from './session-input.js';

export interface AttachIo extends WatchIo {
  cwd: string;
  home: string;
}

export interface AttachOverrides {
  startTimeOf?: StartTimeOf;
}

/** Polling of the state files while the session is unknown or not registered yet. */
const POLL_BACKOFF: BackoffOptions = { minMs: 250, maxMs: 2_000, factor: 2, jitter: 0.2 };
/** A connection that lived this long resets the polling backoff. */
const HEALTHY_MS = 10_000;

const MAX_ID_LENGTH = 128;
// eslint-disable-next-line no-control-regex -- rejects control characters in opaque ids
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function opaque(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value !== '' &&
    value.length <= MAX_ID_LENGTH &&
    !CONTROL_CHARS.test(value)
  );
}

/** Validates one line of the local channel; anything else is dropped. */
export function parseChannelLine(line: string): WatchEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { eventId, senders, count } = raw as Record<string, unknown>;
  if (!opaque(eventId)) return null;
  if (!Array.isArray(senders) || !senders.every(opaque)) return null;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) return null;
  return { eventId, senders, count };
}

type Resolution = { found: false } | { found: true; proxy: ProxyEntry | undefined };

function resolveTarget(paths: StatePaths, sessionId: string, startTimeOf: StartTimeOf): Resolution {
  let names: string[];
  try {
    names = readdirSync(paths.pidMapDir);
  } catch {
    return { found: false };
  }
  for (const name of names) {
    const match = /^(\d+)\.json$/.exec(name);
    if (match === null) continue;
    const pid = Number(match[1]);
    try {
      const entry = readPidMapEntry(paths, pid, startTimeOf);
      if (entry?.sessionId !== sessionId) continue;
      return { found: true, proxy: readLiveProxyEntry(paths, pid, startTimeOf) };
    } catch {
      // An unreadable entry is not the target.
    }
  }
  return { found: false };
}

interface ChannelOutcome {
  connected: boolean;
  busy: boolean;
  livedMs: number;
}

/** Listens on the channel until it closes or the signal aborts. */
function listenOn(
  socketPath: string,
  signal: AbortSignal,
  onEvent: (event: WatchEvent) => void,
): Promise<ChannelOutcome> {
  return new Promise((resolve) => {
    const started = Date.now();
    let connected = false;
    let busy = false;
    let buffer = '';
    const socket = net.createConnection(socketPath);
    const onAbort = (): void => {
      socket.destroy();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    socket.on('connect', () => {
      connected = true;
      socket.write(`${JSON.stringify({ op: 'listen' })}\n`);
    });
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        if (line.includes('"listener_busy"')) {
          busy = true;
          continue;
        }
        const event = parseChannelLine(line);
        if (event !== null) onEvent(event);
      }
      if (buffer.length > 64 * 1024) socket.destroy();
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      signal.removeEventListener('abort', onAbort);
      resolve({ connected, busy, livedMs: Date.now() - started });
    });
  });
}

/** One `once` request: the line the proxy answers, or undefined. */
function onceOn(socketPath: string): Promise<WatchEvent | undefined> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let failed = false;
    const socket = net.createConnection(socketPath);
    socket.on('connect', () => socket.write(`${JSON.stringify({ op: 'once' })}\n`));
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 64 * 1024) socket.destroy();
    });
    socket.on('error', (err) => {
      failed = true;
      reject(err);
    });
    socket.on('close', () => {
      if (failed) return;
      const first = buffer.split('\n').find((l) => l.trim() !== '');
      resolve(first === undefined ? undefined : (parseChannelLine(first) ?? undefined));
    });
  });
}

export async function runAttach(
  input: AttachInput,
  io: AttachIo,
  overrides: AttachOverrides = {},
): Promise<number> {
  const paths = statePaths(configRoot(io.env, io.home));
  const startTimeOf = overrides.startTimeOf ?? processStartTime;
  const emit = (event: WatchEvent): void => io.stdout(`${serializeEventLine(event)}\n`);

  if (input.once) {
    const target = resolveTarget(paths, input.sessionId, startTimeOf);
    if (!target.found || target.proxy === undefined || !target.proxy.registered) {
      throw new WatchError(
        'WATCH_ONCE_FAILED',
        `the session ${input.sessionId} has no registered proxy right now`,
      );
    }
    let event: WatchEvent | undefined;
    try {
      event = await onceOn(target.proxy.socketPath);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new WatchError('WATCH_ONCE_FAILED', `the local channel failed: ${reason}`, {
        cause: err,
      });
    }
    if (event !== undefined) emit(event);
    return EXIT_OK;
  }

  const backoff = io.backoff ?? POLL_BACKOFF;
  const deadline = Date.now() + input.attachTimeoutMs;
  let everFound = false;
  let attempt = 0;
  let lastLog = '';
  const log = (event: string, fields: Record<string, unknown> = {}): void => {
    const key = `${event}${JSON.stringify(fields)}`;
    if (key === lastLog) return;
    lastLog = key;
    io.stderr(`${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}\n`);
  };

  while (!io.signal.aborted) {
    const target = resolveTarget(paths, input.sessionId, startTimeOf);
    if (!target.found) {
      if (!everFound && Date.now() >= deadline) {
        throw new WatchError(
          'WATCH_ATTACH_TARGET_NOT_FOUND',
          `no Claude Code session ${input.sessionId} is known after ${String(input.attachTimeoutMs / 1000)} seconds`,
        );
      }
      log('watch.attach_waiting', { reason: 'session_unknown' });
    } else {
      everFound = true;
      const proxy = target.proxy;
      if (proxy === undefined || !proxy.registered) {
        log('watch.attach_waiting', { reason: 'not_registered' });
      } else {
        log('watch.attach_connecting', { proxyHandle: proxy.proxyHandle });
        const outcome = await listenOn(proxy.socketPath, io.signal, emit);
        if (io.signal.aborted) break;
        if (outcome.livedMs >= HEALTHY_MS) attempt = 0;
        log('watch.attach_lost', { busy: outcome.busy, connected: outcome.connected });
      }
    }
    await abortableSleep(
      backoffDelay(attempt, backoff, () => Math.random()),
      io.signal,
    );
    attempt += 1;
  }
  return EXIT_INTERRUPTED;
}
