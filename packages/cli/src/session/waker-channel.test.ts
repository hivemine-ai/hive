import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openWakerChannel, wakerSocketPath } from './waker-channel.js';
import type { WakerChannel } from './waker-channel.js';

let dir: string;
const channels: WakerChannel[] = [];
const sockets: net.Socket[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hive-wk-'));
  chmodSync(dir, 0o700);
});

afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const c of channels.splice(0)) await c.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Peer {
  lines: string[];
  ended: Promise<void>;
  socket: net.Socket;
}

async function connect(path: string, request: string): Promise<Peer> {
  const socket = net.createConnection(path);
  sockets.push(socket);
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  const lines: string[] = [];
  let buffer = '';
  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      lines.push(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
    }
  });
  const ended = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  socket.write(`${request}\n`);
  return { lines, ended, socket };
}

async function open(
  once: () => Promise<{ eventId: string; senders: string[]; count: number } | undefined>,
) {
  const channel = await openWakerChannel({
    path: join(dir, 'run', 'h.sock'),
    once,
    log: () => undefined,
  });
  channels.push(channel);
  return channel;
}

describe('wakerSocketPath', () => {
  it('uses run/<handle>.sock under the root while the path is short enough', () => {
    expect(wakerSocketPath('/r', 'abc', '/tmp', 501)).toBe('/r/run/abc.sock');
  });

  it('falls back to a per-user directory under the temporary directory when the path is too long', () => {
    const root = `/${'x'.repeat(120)}`;
    expect(wakerSocketPath(root, 'abc', '/tmp', 501)).toBe('/tmp/hive-501/abc.sock');
  });
});

describe('openWakerChannel', () => {
  it('creates a 0600 socket in a 0700 directory and removes it on close', async () => {
    const channel = await open(() => Promise.resolve(undefined));
    expect(statSync(channel.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'run')).mode & 0o777).toBe(0o700);
    await channel.close();
    expect(existsSync(channel.path)).toBe(false);
  });

  it('a listener gets one metadata line per event, with the allowlisted fields only', async () => {
    const channel = await open(() => Promise.resolve(undefined));
    const peer = await connect(channel.path, '{"op":"listen"}');
    await expect.poll(() => channel.listening).toBe(true);

    channel.push({ eventId: 'e1', senders: ['s1'], count: 1 });
    channel.push({ eventId: 'e2', senders: ['s1', 's2'], count: 3 });

    await expect.poll(() => peer.lines.length).toBe(2);
    expect(peer.lines.map((l) => JSON.parse(l) as unknown)).toEqual([
      { eventId: 'e1', senders: ['s1'], count: 1 },
      { eventId: 'e2', senders: ['s1', 's2'], count: 3 },
    ]);
  });

  it('accepts one listener at a time, and a new one once the first leaves', async () => {
    const channel = await open(() => Promise.resolve(undefined));
    const first = await connect(channel.path, '{"op":"listen"}');
    await expect.poll(() => channel.listening).toBe(true);

    const second = await connect(channel.path, '{"op":"listen"}');
    await second.ended;
    expect(second.lines.map((l) => JSON.parse(l) as unknown)).toEqual([{ error: 'listener_busy' }]);

    first.socket.destroy();
    await expect.poll(() => channel.listening).toBe(false);
    const third = await connect(channel.path, '{"op":"listen"}');
    await expect.poll(() => channel.listening).toBe(true);
    channel.push({ eventId: 'e3', senders: [], count: 1 });
    await expect.poll(() => third.lines.length).toBe(1);
  });

  it('once answers one line when something is unread, then closes', async () => {
    const channel = await open(() =>
      Promise.resolve({ eventId: 'check:1', senders: ['s1'], count: 2 }),
    );
    const peer = await connect(channel.path, '{"op":"once"}');
    await peer.ended;
    expect(peer.lines.map((l) => JSON.parse(l) as unknown)).toEqual([
      { eventId: 'check:1', senders: ['s1'], count: 2 },
    ]);
  });

  it('once answers nothing when nothing is unread or the query fails', async () => {
    const empty = await open(() => Promise.resolve(undefined));
    const a = await connect(empty.path, '{"op":"once"}');
    await a.ended;
    expect(a.lines).toEqual([]);

    await empty.close();
    const failing = await open(() => Promise.reject(new Error('down')));
    const b = await connect(failing.path, '{"op":"once"}');
    await b.ended;
    expect(b.lines).toEqual([]);
  });

  it('closes a connection with an unknown request', async () => {
    const channel = await open(() => Promise.resolve(undefined));
    const peer = await connect(channel.path, 'hello');
    await peer.ended;
    expect(peer.lines).toEqual([]);
    expect(channel.listening).toBe(false);
  });
});
