import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WatchEvent } from '@hive/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildChildEnv, createExecRunner } from './exec-runner.js';

const event: WatchEvent = { eventId: 'evt-1', senders: ['s1', 's2'], count: 2 };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hive-exec-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function runner(script: string, extra: Partial<Parameters<typeof createExecRunner>[0]> = {}) {
  const stderr: string[] = [];
  const run = createExecRunner({
    program: process.execPath,
    args: ['-e', script],
    baseEnv: { PATH: process.env['PATH'] ?? '' },
    credential: 'super-secret-credential',
    stopTimeoutMs: 2000,
    stderr: (text) => stderr.push(text),
    ...extra,
  });
  return { run, stderr };
}

describe('buildChildEnv', () => {
  it('adds the event variables and drops HIVE_WATCH_* and the credential value', () => {
    const env = buildChildEnv(
      {
        PATH: '/bin',
        ANTHROPIC_API_KEY: 'k',
        HIVE_WATCH_CREDENTIAL_FILE: '/c',
        HIVE_WATCH_SERVER_URL: 'http://x',
        LEAK: 'super-secret-credential',
      },
      event,
      'super-secret-credential',
    );
    expect(env).toMatchObject({
      PATH: '/bin',
      ANTHROPIC_API_KEY: 'k',
      HIVE_EVENT_ID: 'evt-1',
      HIVE_EVENT_SENDERS: 's1,s2',
      HIVE_EVENT_COUNT: '2',
    });
    expect(env['HIVE_WATCH_CREDENTIAL_FILE']).toBeUndefined();
    expect(env['HIVE_WATCH_SERVER_URL']).toBeUndefined();
    expect(env['LEAK']).toBeUndefined();
  });
});

describe('createExecRunner', () => {
  it('passes the event line on stdin and the metadata in the environment', async () => {
    const out = join(dir, 'out.json');
    const { run } = runner(
      `let d='';process.stdin.on('data',c=>d+=c).on('end',()=>require('fs').writeFileSync(${JSON.stringify(out)},JSON.stringify({stdin:d,env:{id:process.env.HIVE_EVENT_ID,s:process.env.HIVE_EVENT_SENDERS,c:process.env.HIVE_EVENT_COUNT,cred:process.env.HIVE_WATCH_CREDENTIAL_FILE}})))`,
    );
    expect(await run(event, new AbortController().signal)).toBe(0);
    const got = JSON.parse(readFileSync(out, 'utf8')) as {
      stdin: string;
      env: Record<string, string | null>;
    };
    expect(JSON.parse(got.stdin)).toEqual({ eventId: 'evt-1', senders: ['s1', 's2'], count: 2 });
    expect(got.env).toEqual({ id: 'evt-1', s: 's1,s2', c: '2' });
  });

  it('returns the exit code of the command', async () => {
    const { run } = runner('process.exit(3)');
    expect(await run(event, new AbortController().signal)).toBe(3);
  });

  it('sends the child stdout to stderr so stdout carries event lines only', async () => {
    const { run, stderr } = runner('console.log("from child")');
    await run(event, new AbortController().signal);
    expect(stderr.join('')).toContain('from child');
  });

  it('rejects when the command cannot be launched', async () => {
    const { run } = runner('', { program: join(dir, 'missing-binary'), args: [] });
    await expect(run(event, new AbortController().signal)).rejects.toThrow();
  });

  it('does not interpret shell syntax in its arguments', async () => {
    const marker = join(dir, 'pwned');
    const out = join(dir, 'argv.json');
    const { run } = runner('', {
      args: [
        '-e',
        `require('fs').writeFileSync(${JSON.stringify(out)},JSON.stringify(process.argv.slice(1)))`,
        `$(touch ${marker})`,
        '; touch ' + marker,
      ],
    });
    await run(event, new AbortController().signal);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual([
      `$(touch ${marker})`,
      '; touch ' + marker,
    ]);
    expect(() => readFileSync(marker)).toThrow();
  });

  it('waits for the running child when aborted, then returns its code', async () => {
    const ac = new AbortController();
    const { run } = runner('setTimeout(()=>process.exit(0),400)');
    const pending = run(event, ac.signal);
    setTimeout(() => ac.abort(), 100);
    const started = Date.now();
    expect(await pending).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
  });

  it('terminates a child that outlives the stop timeout', async () => {
    const ac = new AbortController();
    const { run } = runner('setTimeout(()=>{},60000)', { stopTimeoutMs: 200 });
    const pending = run(event, ac.signal);
    setTimeout(() => ac.abort(), 100);
    const code = await pending;
    expect(code).not.toBe(0);
  });
});
