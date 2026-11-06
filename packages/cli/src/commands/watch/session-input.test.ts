import { describe, expect, it } from 'vitest';

import { isSessionMode, resolveSessionWatchInput } from './session-input.js';
import type { RawWatchOptions } from './input.js';
import { thrownCode } from './test-utils.js';

function omit(keys: string[]): RawWatchOptions {
  const copy: Record<string, unknown> = { ...harness };
  for (const key of keys) delete copy[key];
  if (keys.includes('exec')) copy['execArgs'] = [];
  return copy as unknown as RawWatchOptions;
}

const harness = {
  sessionName: 'nightly-worker',
  sessionDescription: 'Runs the nightly report',
  exec: './wake.sh',
  execArgs: ['--flag'],
};

describe('isSessionMode', () => {
  it('is true for any of the session flags and false for a classic watch', () => {
    expect(isSessionMode({ execArgs: [] })).toBe(false);
    expect(isSessionMode({ server: 'http://h/mcp', execArgs: [] })).toBe(false);
    expect(isSessionMode({ sessionName: 'x', execArgs: [] })).toBe(true);
    expect(isSessionMode({ sessionDescription: 'x', execArgs: [] })).toBe(true);
    expect(isSessionMode({ attachSession: 's', execArgs: [] })).toBe(true);
    expect(isSessionMode({ stateFile: '/s', execArgs: [] })).toBe(true);
    expect(isSessionMode({ inlineMcpConfig: true, execArgs: [] })).toBe(true);
  });
});

describe('resolveSessionWatchInput: harness', () => {
  it('resolves the harness mode with the watch defaults', () => {
    const input = resolveSessionWatchInput(harness, {});
    expect(input).toMatchObject({
      kind: 'harness',
      name: 'nightly-worker',
      description: 'Runs the nightly report',
      exec: { program: './wake.sh', args: ['--flag'] },
      inlineMcpConfig: false,
      silenceTimeoutMs: 45_000,
      probeTimeoutMs: 20_000,
      authRetryMaxMs: 300_000,
      execMaxRetries: 3,
      execStopTimeoutMs: 30_000,
    });
    if (input.kind !== 'harness') throw new Error('kind');
    expect(input.server).toBeUndefined();
    expect(input.credentialFile).toBeUndefined();
    expect(input.stateFile).toBeUndefined();
  });

  it('keeps an explicit server, credential file, state file and --inline-mcp-config', () => {
    const input = resolveSessionWatchInput(
      {
        ...harness,
        server: 'https://hive.example/mcp',
        credentialFile: '/c/enroll',
        stateFile: '/s/state.json',
        inlineMcpConfig: true,
      },
      {},
    );
    expect(input).toMatchObject({
      server: 'https://hive.example/mcp',
      credentialFile: '/c/enroll',
      stateFile: '/s/state.json',
      inlineMcpConfig: true,
    });
  });

  it('never takes the classic credential defaults from the environment', () => {
    const input = resolveSessionWatchInput(harness, {
      HIVE_WATCH_CREDENTIAL_FILE: '/env/cred',
    });
    if (input.kind !== 'harness') throw new Error('kind');
    expect(input.credentialFile).toBeUndefined();
  });

  it.each([
    ['--session-name without --session-description', omit(['sessionDescription'])],
    ['--session-name without --exec', omit(['exec'])],
    ['--session-description without --session-name', omit(['sessionName'])],
    ['--session-name with --once', { ...harness, once: true }],
    ['--session-name with --attach-session', { ...harness, attachSession: 'sid' }],
    ['an empty name', { ...harness, sessionName: '' }],
    ['a name with a control character', { ...harness, sessionName: 'a\u0007b' }],
    [
      'a description longer than 280 characters',
      { ...harness, sessionDescription: 'x'.repeat(281) },
    ],
    ['a description on two lines', { ...harness, sessionDescription: 'one\ntwo' }],
    ['a description with a control character', { ...harness, sessionDescription: 'a\u0000b' }],
    ['--state-file without --session-name', { stateFile: '/s', execArgs: [] }],
    ['--inline-mcp-config without --session-name', { inlineMcpConfig: true, execArgs: [] }],
  ])('rejects %s with WATCH_INVALID_OPTION', (_label, raw: RawWatchOptions) => {
    expect(thrownCode(() => resolveSessionWatchInput(raw, {}))).toBe('WATCH_INVALID_OPTION');
  });

  it('accepts a description of exactly 280 characters', () => {
    const input = resolveSessionWatchInput({ ...harness, sessionDescription: 'x'.repeat(280) }, {});
    expect(input.kind).toBe('harness');
  });

  it('rejects a server that is not http(s)', () => {
    expect(thrownCode(() => resolveSessionWatchInput({ ...harness, server: 'ftp://h' }, {}))).toBe(
      'WATCH_INVALID_OPTION',
    );
  });
});

describe('resolveSessionWatchInput: attach', () => {
  it('resolves --attach-session, with --once or without', () => {
    expect(resolveSessionWatchInput({ attachSession: 'sid-1', execArgs: [] }, {})).toMatchObject({
      kind: 'attach',
      sessionId: 'sid-1',
      once: false,
      attachTimeoutMs: 30_000,
    });
    expect(
      resolveSessionWatchInput({ attachSession: 'sid-1', once: true, execArgs: [] }, {}),
    ).toMatchObject({ kind: 'attach', once: true });
  });

  it.each([
    ['--exec', { exec: 'x' }],
    ['--server', { server: 'http://h/mcp' }],
    ['--credential-file', { credentialFile: '/c' }],
    ['an empty session id', { attachSession: '' }],
  ])('rejects --attach-session with %s', (_label, extra) => {
    expect(
      thrownCode(() =>
        resolveSessionWatchInput({ attachSession: 'sid', execArgs: [], ...extra }, {}),
      ),
    ).toBe('WATCH_INVALID_OPTION');
  });
});
