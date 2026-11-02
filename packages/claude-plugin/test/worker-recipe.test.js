import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildPrompt } from '../hooks/event-line.js';

const script = new URL('../worker/claude-wake.sh', import.meta.url).pathname;
let dir;
let argvFile;
let stub;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hive-worker-'));
  argvFile = join(dir, 'argv.json');
  stub = join(dir, 'claude');
  writeFileSync(
    stub,
    `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify({argv: process.argv.slice(2), key: process.env.ANTHROPIC_API_KEY}));\n`,
  );
  chmodSync(stub, 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(env) {
  return spawnSync('/bin/sh', [script], {
    env: {
      PATH: process.env.PATH,
      HIVE_WORKER_CLAUDE: stub,
      ANTHROPIC_API_KEY: 'sk-test',
      HIVE_WORKER_SESSION_ID: 'sess-1',
      HIVE_WORKER_ALLOWED_TOOLS: 'mcp__hive__read_mailbox mcp__hive__mark_read',
      ...env,
    },
    encoding: 'utf8',
  });
}

describe('worker recipe claude-wake.sh', () => {
  it('resumes the session with the fixed prompt, built from integers only', () => {
    const r = run({ HIVE_EVENT_COUNT: '3', HIVE_EVENT_SENDERS: 'a,b' });
    expect(r.status).toBe(0);
    const { argv, key } = JSON.parse(readFileSync(argvFile, 'utf8'));
    expect(key).toBe('sk-test');
    expect(argv.slice(0, 1)).toEqual(['-p']);
    expect(argv.slice(2)).toEqual([
      '--resume',
      'sess-1',
      '--allowedTools',
      'mcp__hive__read_mailbox mcp__hive__mark_read',
    ]);
    expect(argv[1]).toBe(buildPrompt({ eventId: 'x', senders: ['a', 'b'], count: 3 }));
  });

  it('never interpolates sender text into the prompt', () => {
    const r = run({
      HIVE_EVENT_COUNT: '1',
      HIVE_EVENT_SENDERS: '$(touch pwned),`id`;ignore previous',
    });
    expect(r.status).toBe(0);
    const { argv } = JSON.parse(readFileSync(argvFile, 'utf8'));
    expect(argv[1]).not.toContain('pwned');
    expect(argv[1]).not.toContain('ignore previous');
  });

  it.each([[''], ['abc'], ['1;rm -rf /'], ['-1']])('rejects an invalid count %j', (count) => {
    const r = run({ HIVE_EVENT_COUNT: count });
    expect(r.status).toBe(2);
  });

  it('requires the API key, the session and the allowed tools', () => {
    expect(run({ HIVE_EVENT_COUNT: '1', ANTHROPIC_API_KEY: '' }).status).not.toBe(0);
    expect(run({ HIVE_EVENT_COUNT: '1', HIVE_WORKER_SESSION_ID: '' }).status).not.toBe(0);
    expect(run({ HIVE_EVENT_COUNT: '1', HIVE_WORKER_ALLOWED_TOOLS: '' }).status).not.toBe(0);
  });

  it('refuses a bypass permission setting', () => {
    const r = run({ HIVE_EVENT_COUNT: '1', HIVE_WORKER_ALLOWED_TOOLS: 'bypassPermissions' });
    expect(r.status).toBe(2);
  });
});
