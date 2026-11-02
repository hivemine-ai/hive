import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startFakeHiveServer } from '@hive/client/testing';
import type { FakeHiveServer } from '@hive/client/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EXIT_INTERRUPTED } from '#error/exit-codes.js';

import { resolveWatchInput } from './input.js';
import type { RawWatchOptions, WatchInput } from './input.js';
import type { WatchIo } from './io.js';
import { runWatchOnce } from './run-once.js';
import { runWatch } from './run-watch.js';
import { thrownCode } from './test-utils.js';

const TOKEN = 'tok-abc.def.ghi';
const ME = 'agent-1';
const FAST = { minMs: 20, maxMs: 80, factor: 2, jitter: 0 };

let dir: string;
let credentialFile: string;
let server: FakeHiveServer;
let stdout: string[];
let stderr: string[];
let controller: AbortController;

const waitFor = async (cond: () => boolean, ms = 6000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end)
      throw new Error(
        `timed out; stdout=${stdout.join('|')} stderr=${stderr.join('|').slice(-500)}`,
      );
    await new Promise((r) => setTimeout(r, 20));
  }
};

const lines = (): unknown[] =>
  stdout
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as unknown);

function io(extra: Partial<WatchIo> = {}): WatchIo {
  return {
    stdout: (t) => stdout.push(t),
    stderr: (t) => stderr.push(t),
    env: { PATH: process.env['PATH'] ?? '' },
    signal: controller.signal,
    backoff: FAST,
    ...extra,
  };
}

function input(extra: Partial<RawWatchOptions> = {}): WatchInput {
  return resolveWatchInput(
    { server: server.url, credentialFile, execArgs: [], ...extra },
    { HIVE_WATCH_AUTH_RETRY_MAX_SECONDS: '1' },
  );
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hive-watch-'));
  chmodSync(dir, 0o700);
  credentialFile = join(dir, 'credential');
  writeFileSync(credentialFile, TOKEN, { mode: 0o600 });
  server = await startFakeHiveServer({ tokens: { [TOKEN]: ME }, replayOnListen: true });
  stdout = [];
  stderr = [];
  controller = new AbortController();
});

afterEach(async () => {
  controller.abort();
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('hivectl watch', () => {
  it('prints one metadata line per event and keeps the participant online', async () => {
    const run = runWatch(input(), io());
    await waitFor(() => server.online().includes(ME));
    server.publish(ME, { eventId: 'evt-1', senders: ['s1'], count: 1 });
    await waitFor(() => lines().length === 1);
    expect(lines()[0]).toEqual({ eventId: 'evt-1', senders: ['s1'], count: 1 });
    expect(server.online()).toEqual([ME]);
    controller.abort();
    expect(await run).toBe(EXIT_INTERRUPTED);
  });

  it('calls no tool on connect and recovers through the replay, never touching read_mailbox', async () => {
    server.setUnread(ME, { count: 2, senders: ['s1'] });
    const run = runWatch(input(), io());
    await waitFor(() => lines().length === 1);
    server.dropStreams();
    await waitFor(() => server.listenCount() === 2);
    await waitFor(() => lines().length === 2);
    expect(server.methods).not.toContain('tools/call');
    expect(server.toolCalls).toEqual([]);
    controller.abort();
    await run;
  });

  it('prints a replay exactly like an online event', async () => {
    server.setUnread(ME, { count: 2, senders: ['s1'] });
    const run = runWatch(input(), io());
    await waitFor(() => lines().length === 1);
    server.publish(ME, { eventId: 'live', senders: ['s1'], count: 2 });
    await waitFor(() => lines().length === 2);
    const [replay, live] = lines() as Record<string, unknown>[];
    expect(Object.keys(replay ?? {})).toEqual(Object.keys(live ?? {}));
    controller.abort();
    await run;
  });

  it('never writes anything but event lines to stdout, and never the credential anywhere', async () => {
    const run = runWatch(input(), io());
    await waitFor(() => server.online().includes(ME));
    server.publish(ME, { eventId: 'evt-1', senders: ['s1'], count: 1 });
    await waitFor(() => lines().length === 1);
    controller.abort();
    await run;
    for (const l of lines() as Record<string, unknown>[]) {
      expect(Object.keys(l)).toEqual(['eventId', 'senders', 'count']);
    }
    expect(stdout.join('') + stderr.join('')).not.toContain(TOKEN);
    expect(stderr.join('')).toContain('watch.connected');
  });

  it('ends with WATCH_CREDENTIAL_REJECTED once a continuous rejection spends its window', async () => {
    server.setRejectAuth(true);
    await expect(runWatch(input(), io())).rejects.toMatchObject({
      code: 'WATCH_CREDENTIAL_REJECTED',
    });
    expect(stdout.join('') + stderr.join('')).not.toContain(TOKEN);
  });

  it('ends with an unsupported protocol error at once', async () => {
    server.setUnsupportedProtocol(true);
    await expect(runWatch(input(), io())).rejects.toMatchObject({ kind: 'protocol_unsupported' });
  });

  it('fails fast when the credential file is too open', async () => {
    chmodSync(credentialFile, 0o644);
    await expect(runWatch(input(), io())).rejects.toMatchObject({
      code: 'WATCH_CREDENTIAL_INSECURE_PERMS',
    });
    expect(server.listenCount()).toBe(0);
  });

  it('writes no state to disk', async () => {
    const run = runWatch(input(), io());
    await waitFor(() => server.online().includes(ME));
    server.publish(ME, { eventId: 'evt-1', senders: ['s1'], count: 1 });
    await waitFor(() => lines().length === 1);
    controller.abort();
    await run;
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(dir)).toEqual(['credential']);
  });
});

describe('hivectl watch --exec', () => {
  const script = (body: string): { program: string; execArgs: string[] } => ({
    program: process.execPath,
    execArgs: ['-e', body],
  });

  function execInput(body: string): WatchInput {
    const s = script(body);
    return input({ exec: s.program, execArgs: s.execArgs });
  }

  it('runs the command once per event with the metadata on stdin', async () => {
    const out = join(dir, 'runs.log');
    const body = `let d='';process.stdin.on('data',c=>d+=c).on('end',()=>require('fs').appendFileSync(${JSON.stringify(out)},d))`;
    const run = runWatch(execInput(body), io());
    await waitFor(() => server.online().includes(ME));
    server.publish(ME, { eventId: 'evt-1', senders: ['s1'], count: 1 });
    await waitFor(() => {
      try {
        return readFileSync(out, 'utf8').includes('evt-1');
      } catch {
        return false;
      }
    });
    expect(JSON.parse(readFileSync(out, 'utf8').trim()) as unknown).toEqual({
      eventId: 'evt-1',
      senders: ['s1'],
      count: 1,
    });
    controller.abort();
    await run;
  });

  it('collapses events that arrive during a run into one query, and reruns only when unread', async () => {
    const out = join(dir, 'runs.log');
    const body = `require('fs').appendFileSync(${JSON.stringify(out)},'run\\n');setTimeout(()=>{},500)`;
    const run = runWatch(execInput(body), io());
    await waitFor(() => server.online().includes(ME));
    server.setUnread(ME, { count: 3, senders: ['s1', 's2'] });
    server.publish(ME, { eventId: 'e0', senders: ['s1'], count: 1 });
    await waitFor(() => server.listenCount() === 1 && lines().length === 1);
    for (let i = 1; i <= 5; i += 1)
      server.publish(ME, { eventId: `e${i}`, senders: ['s1'], count: 1 });
    await waitFor(() => lines().length === 2, 8000);
    expect(server.toolCalls.filter((c) => c === 'check_unread_messages')).toHaveLength(1);
    const second = lines()[1] as { eventId: string; count: number };
    expect(second.eventId).toMatch(/^check:/);
    expect(second.count).toBe(3);
    await waitFor(() => readFileSync(out, 'utf8').split('\n').filter(Boolean).length === 2, 8000);
    controller.abort();
    await run;
  });

  it('does not rerun when the query finds nothing unread', async () => {
    const body = `setTimeout(()=>{},300)`;
    const run = runWatch(execInput(body), io());
    await waitFor(() => server.online().includes(ME));
    server.publish(ME, { eventId: 'e0', senders: ['s1'], count: 1 });
    await waitFor(() => lines().length === 1);
    server.publish(ME, { eventId: 'e1', senders: ['s1'], count: 1 });
    await waitFor(() => server.toolCalls.includes('check_unread_messages'), 8000);
    await new Promise((r) => setTimeout(r, 300));
    expect(lines()).toHaveLength(1);
    controller.abort();
    await run;
  });

  it('retries a failing command and ends with WATCH_EXEC_FAILED when the retries run out', async () => {
    const s = script('process.exit(9)');
    const run = runWatch(
      resolveWatchInput(
        { server: server.url, credentialFile, exec: s.program, execArgs: s.execArgs },
        { HIVE_WATCH_EXEC_MAX_RETRIES: '2' },
      ),
      io(),
    );
    await waitFor(() => server.online().includes(ME));
    server.publish(ME, { eventId: 'evt-fail', senders: ['s1'], count: 1 });
    await expect(run).rejects.toMatchObject({ code: 'WATCH_EXEC_FAILED' });
    expect(stderr.join('').match(/watch\.exec_failed/g)).toHaveLength(3);
  });

  it('delivers what is still unread again when watch is relaunched after WATCH_EXEC_FAILED', async () => {
    server.setUnread(ME, { count: 2, senders: ['s1'] });
    const failing = script('process.exit(9)');
    await expect(
      runWatch(
        resolveWatchInput(
          { server: server.url, credentialFile, exec: failing.program, execArgs: failing.execArgs },
          { HIVE_WATCH_EXEC_MAX_RETRIES: '0' },
        ),
        io(),
      ),
    ).rejects.toMatchObject({ code: 'WATCH_EXEC_FAILED' });
    expect(server.listenCount()).toBe(1);

    const out = join(dir, 'second-run.log');
    const body = `require('fs').appendFileSync(${JSON.stringify(out)},'woken\\n')`;
    const run = runWatch(execInput(body), io());
    await waitFor(() => {
      try {
        return readFileSync(out, 'utf8').includes('woken');
      } catch {
        return false;
      }
    });
    expect(server.listenCount()).toBe(2);
    expect(server.toolCalls).toEqual([]);
    controller.abort();
    await run;
  });

  it('keeps the stream open between runs so the worker stays online', async () => {
    const run = runWatch(execInput('process.exit(0)'), io());
    await waitFor(() => server.online().includes(ME));
    server.publish(ME, { eventId: 'evt-1', senders: ['s1'], count: 1 });
    await waitFor(() => lines().length === 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(server.online()).toEqual([ME]);
    controller.abort();
    await run;
  });

  it('waits for a running command before exiting on interruption', async () => {
    const out = join(dir, 'done');
    const body = `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(out)},'x'),600)`;
    const run = runWatch(execInput(body), io());
    await waitFor(() => server.online().includes(ME));
    server.publish(ME, { eventId: 'evt-1', senders: ['s1'], count: 1 });
    await waitFor(() => lines().length === 1);
    controller.abort();
    expect(await run).toBe(EXIT_INTERRUPTED);
    expect(readFileSync(out, 'utf8')).toBe('x');
  });
});

describe('hivectl watch --once', () => {
  it('prints one line with the unread metadata and creates no presence', async () => {
    server.setUnread(ME, { count: 2, senders: ['s1', 's2'] });
    expect(await runWatchOnce(input({ once: true }), io())).toBe(0);
    const [line] = lines() as { eventId: string; senders: string[]; count: number }[];
    expect(line?.eventId).toMatch(/^check:[0-9a-f-]{36}$/);
    expect(line).toMatchObject({ senders: ['s1', 's2'], count: 2 });
    expect(server.toolCalls.filter((c) => c === 'check_unread_messages')).toHaveLength(1);
    expect(server.toolCalls).not.toContain('read_mailbox');
    expect(server.listenCount()).toBe(0);
    expect(server.online()).toEqual([]);
  });

  it('prints nothing and exits 0 when nothing is unread', async () => {
    expect(await runWatchOnce(input({ once: true }), io())).toBe(0);
    expect(stdout).toEqual([]);
  });

  it('ends at once with WATCH_CREDENTIAL_REJECTED and prints no line', async () => {
    server.setRejectAuth(true);
    await expect(runWatchOnce(input({ once: true }), io())).rejects.toMatchObject({
      code: 'WATCH_CREDENTIAL_REJECTED',
    });
    expect(stdout).toEqual([]);
  });

  it('ends with WATCH_ONCE_FAILED on any other failure and prints no line', async () => {
    server.setCheckFails(true);
    await expect(runWatchOnce(input({ once: true }), io())).rejects.toMatchObject({
      code: 'WATCH_ONCE_FAILED',
    });
    expect(stdout).toEqual([]);
  });

  it('is exclusive with --exec', () => {
    expect(thrownCode(() => input({ once: true, exec: 'x' }))).toBe('WATCH_ONCE_EXEC_CONFLICT');
  });
});

describe('hivectl watch with the credential of a Hivekeeper', () => {
  it('works the same as with an Agent credential', async () => {
    await server.close();
    server = await startFakeHiveServer({ tokens: { [TOKEN]: 'hivekeeper-1' } });
    const run = runWatch(input(), io());
    await waitFor(() => server.online().includes('hivekeeper-1'));
    server.publish('hivekeeper-1', { eventId: 'k1', senders: ['s'], count: 1 });
    await waitFor(() => lines().length === 1);
    controller.abort();
    await run;
  });
});
