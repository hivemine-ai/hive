// Local channel of the waker (ADR-026 3.a): a user socket (0600 in a 0700
// directory) through which `hivectl watch --attach-session` consumes the single
// stream of the proxy instead of opening its own. Protocol: JSON lines. The first
// line of a connection is the request:
//   {"op":"listen"} — one metadata line per stream event (eventId, senders, count;
//                     never a body). One listener at a time; a second one gets
//                     {"error":"listener_busy"} and is closed.
//   {"op":"once"}   — the proxy runs check_unread_messages with its token and
//                     answers one line, or nothing, then closes.

import { chmodSync } from 'node:fs';
import * as net from 'node:net';
import { dirname, join } from 'node:path';

import { serializeEventLine } from '@hive/client';
import type { WatchEvent } from '@hive/client';

import { ensurePrivateDir, removePrivateFile } from './state-dir.js';

/** sun_path is 104 bytes on macOS and 108 on Linux, terminator included. */
const MAX_SOCKET_PATH = 100;
const MAX_REQUEST_BYTES = 1024;

export function wakerSocketPath(root: string, handle: string, tmp: string, uid: number): string {
  const preferred = join(root, 'run', `${handle}.sock`);
  if (Buffer.byteLength(preferred) <= MAX_SOCKET_PATH) return preferred;
  return join(tmp, `hive-${String(uid)}`, `${handle}.sock`);
}

export interface WakerChannelOptions {
  path: string;
  once(): Promise<WatchEvent | undefined>;
  log(event: string, fields: Record<string, unknown>): void;
}

export interface WakerChannel {
  readonly path: string;
  readonly listening: boolean;
  push(event: WatchEvent): void;
  close(): Promise<void>;
}

export async function openWakerChannel(options: WakerChannelOptions): Promise<WakerChannel> {
  ensurePrivateDir(dirname(options.path));
  removePrivateFile(options.path);
  let listener: net.Socket | undefined;
  const open = new Set<net.Socket>();

  const serveOnce = async (socket: net.Socket): Promise<void> => {
    try {
      const event = await options.once();
      if (event !== undefined) socket.write(`${serializeEventLine(event)}\n`);
    } catch (err) {
      options.log('waker.once_failed', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
    socket.end();
  };

  const onRequest = (socket: net.Socket, line: string): void => {
    let op: unknown;
    try {
      op = (JSON.parse(line) as { op?: unknown } | null)?.op;
    } catch {
      op = undefined;
    }
    if (op === 'once') {
      void serveOnce(socket);
      return;
    }
    if (op === 'listen') {
      if (listener !== undefined) {
        socket.end(`${JSON.stringify({ error: 'listener_busy' })}\n`);
        return;
      }
      listener = socket;
      socket.once('close', () => {
        if (listener === socket) listener = undefined;
      });
      return;
    }
    socket.destroy();
  };

  const server = net.createServer((socket) => {
    open.add(socket);
    socket.once('close', () => open.delete(socket));
    socket.on('error', () => socket.destroy());
    let buffer = '';
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8');
      const index = buffer.indexOf('\n');
      if (index >= 0) {
        socket.off('data', onData);
        onRequest(socket, buffer.slice(0, index));
      } else if (buffer.length > MAX_REQUEST_BYTES) {
        socket.destroy();
      }
    };
    socket.on('data', onData);
  });

  // The socket file is created by bind(2) with the umask; a 077 umask makes it
  // 0600 from the start. process.umask is unavailable in worker threads: there
  // the 0700 directory still keeps it private until the chmod below.
  let previousUmask: number | undefined;
  try {
    previousUmask = process.umask(0o077);
  } catch {
    previousUmask = undefined;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.path, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } finally {
    if (previousUmask !== undefined) process.umask(previousUmask);
  }
  chmodSync(options.path, 0o600);
  server.unref();

  return {
    path: options.path,
    get listening() {
      return listener !== undefined;
    },
    push(event) {
      listener?.write(`${serializeEventLine(event)}\n`);
    },
    async close() {
      for (const socket of open) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      removePrivateFile(options.path);
    },
  };
}
