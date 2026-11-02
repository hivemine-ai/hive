import { describe, expect, it } from 'vitest';

import { defaultCredentialPath, resolveWatchInput } from './input.js';
import { thrownCode } from './test-utils.js';

const base = { server: 'http://127.0.0.1:8443/mcp', credentialFile: '/c/credential', execArgs: [] };

describe('resolveWatchInput', () => {
  it('applies the documented defaults', () => {
    const input = resolveWatchInput(base, {});
    expect(input).toMatchObject({
      server: 'http://127.0.0.1:8443/mcp',
      credentialFile: '/c/credential',
      once: false,
      silenceTimeoutMs: 45_000,
      probeTimeoutMs: 20_000,
      authRetryMaxMs: 300_000,
      execMaxRetries: 3,
    });
    expect(input.exec).toBeUndefined();
  });

  it('reads the server and the credential file from the environment', () => {
    const input = resolveWatchInput(
      { execArgs: [] },
      {
        HIVE_WATCH_SERVER_URL: 'https://hive.example/mcp',
        HIVE_WATCH_CREDENTIAL_FILE: '/env/cred',
      },
    );
    expect(input.server).toBe('https://hive.example/mcp');
    expect(input.credentialFile).toBe('/env/cred');
  });

  it('lets flags override the environment', () => {
    const input = resolveWatchInput(base, {
      HIVE_WATCH_SERVER_URL: 'https://other/mcp',
      HIVE_WATCH_CREDENTIAL_FILE: '/env/cred',
    });
    expect(input.server).toBe('http://127.0.0.1:8443/mcp');
    expect(input.credentialFile).toBe('/c/credential');
  });

  it('fails with WATCH_SERVER_URL_MISSING when no server is given', () => {
    expect(thrownCode(() => resolveWatchInput({ credentialFile: '/c', execArgs: [] }, {}))).toBe(
      'WATCH_SERVER_URL_MISSING',
    );
  });

  it.each(['not a url', 'ftp://host/mcp', ''])('rejects the server URL %j', (server) => {
    expect(thrownCode(() => resolveWatchInput({ ...base, server }, {}))).toMatch(
      /^WATCH_(INVALID_OPTION|SERVER_URL_MISSING)$/,
    );
  });

  it('rejects --once together with --exec', () => {
    expect(thrownCode(() => resolveWatchInput({ ...base, once: true, exec: './run.sh' }, {}))).toBe(
      'WATCH_ONCE_EXEC_CONFLICT',
    );
  });

  it('keeps exec arguments as separate argv entries', () => {
    const input = resolveWatchInput({ ...base, exec: './run.sh', execArgs: ['--a', 'b c'] }, {});
    expect(input.exec).toEqual({ program: './run.sh', args: ['--a', 'b c'] });
  });

  it('rejects positional arguments without --exec', () => {
    expect(thrownCode(() => resolveWatchInput({ ...base, execArgs: ['x'] }, {}))).toBe(
      'WATCH_INVALID_OPTION',
    );
  });

  it('takes timeouts and limits from flags and environment', () => {
    const input = resolveWatchInput(
      { ...base, silenceTimeout: '30', probeTimeout: '10' },
      { HIVE_WATCH_AUTH_RETRY_MAX_SECONDS: '60', HIVE_WATCH_EXEC_MAX_RETRIES: '5' },
    );
    expect(input).toMatchObject({
      silenceTimeoutMs: 30_000,
      probeTimeoutMs: 10_000,
      authRetryMaxMs: 60_000,
      execMaxRetries: 5,
    });
  });

  it('accepts zero for the auth window and the retries', () => {
    const input = resolveWatchInput(base, {
      HIVE_WATCH_AUTH_RETRY_MAX_SECONDS: '0',
      HIVE_WATCH_EXEC_MAX_RETRIES: '0',
    });
    expect(input.authRetryMaxMs).toBe(0);
    expect(input.execMaxRetries).toBe(0);
  });

  it.each([
    [{ silenceTimeout: '0' }, {}],
    [{ silenceTimeout: 'abc' }, {}],
    [{ probeTimeout: '60' }, {}],
    [{ probeTimeout: '-1' }, {}],
    [{}, { HIVE_WATCH_EXEC_MAX_RETRIES: '-1' }],
    [{}, { HIVE_WATCH_AUTH_RETRY_MAX_SECONDS: 'x' }],
  ])('rejects invalid numeric options %j %j', (flags, env) => {
    expect(thrownCode(() => resolveWatchInput({ ...base, ...flags }, env))).toBe(
      'WATCH_INVALID_OPTION',
    );
  });
});

describe('defaultCredentialPath', () => {
  it('uses Application Support on macOS', () => {
    expect(defaultCredentialPath('darwin', {}, '/Users/u')).toBe(
      '/Users/u/Library/Application Support/hivectl/credential',
    );
  });

  it('honours XDG_CONFIG_HOME on Linux', () => {
    expect(defaultCredentialPath('linux', { XDG_CONFIG_HOME: '/xdg' }, '/home/u')).toBe(
      '/xdg/hivectl/credential',
    );
  });

  it('falls back to ~/.config on Linux', () => {
    expect(defaultCredentialPath('linux', {}, '/home/u')).toBe(
      '/home/u/.config/hivectl/credential',
    );
  });
});
