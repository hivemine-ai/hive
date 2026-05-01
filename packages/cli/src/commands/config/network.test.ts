import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BIND_ALL_HOST, LOCAL_ONLY_HOST, runConfigNetwork } from './network.js';
import { readConfigFile } from './loader.js';

let workDir: string;
let stdoutBuf: string[];
let stderrBuf: string[];
let stdoutSink: Writable;
let stderrSink: Writable;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'hive-config-network-test-'));
  stdoutBuf = [];
  stderrBuf = [];
  stdoutSink = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      stdoutBuf.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      cb();
    },
  });
  stderrSink = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      stderrBuf.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      cb();
    },
  });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('runConfigNetwork', () => {
  it('local-only writes httpHost=127.0.0.1 and confirms on stdout (no stderr)', async () => {
    const configPath = path.join(workDir, 'config.json');
    const result = await runConfigNetwork(
      { mode: 'local-only', configPath },
      { stdout: stdoutSink, stderr: stderrSink },
    );
    expect(result).toEqual({ configPath, httpHost: LOCAL_ONLY_HOST });
    expect(readConfigFile(configPath)).toEqual({ httpHost: LOCAL_ONLY_HOST });
    expect(stdoutBuf.join('')).toContain('local-only set (httpHost=127.0.0.1)');
    expect(stderrBuf.join('')).toBe('');
  });

  it('bind-all writes httpHost=0.0.0.0 AND emits the WARNING on stderr', async () => {
    const configPath = path.join(workDir, 'config.json');
    await runConfigNetwork(
      { mode: 'bind-all', configPath },
      { stdout: stdoutSink, stderr: stderrSink },
    );
    expect(readConfigFile(configPath)).toEqual({ httpHost: BIND_ALL_HOST });
    const warning = stderrBuf.join('');
    expect(warning).toContain('WARNING: bind-all exposes the MCP server');
    expect(warning).toContain('FLAG-005');
    expect(warning).toContain('TLS termination');
    expect(stdoutBuf.join('')).toContain('bind-all set (httpHost=0.0.0.0)');
  });

  it('preserves other keys in the config file when toggling httpHost', async () => {
    const configPath = path.join(workDir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({ httpHost: '127.0.0.1', someFutureKey: 'preserve-me' }),
      'utf8',
    );
    await runConfigNetwork(
      { mode: 'bind-all', configPath },
      { stdout: stdoutSink, stderr: stderrSink },
    );
    expect(readConfigFile(configPath)).toEqual({
      httpHost: BIND_ALL_HOST,
      someFutureKey: 'preserve-me',
    });
  });

  it('idempotent — toggling local-only twice produces the same file', async () => {
    const configPath = path.join(workDir, 'config.json');
    await runConfigNetwork(
      { mode: 'local-only', configPath },
      { stdout: stdoutSink, stderr: stderrSink },
    );
    await runConfigNetwork(
      { mode: 'local-only', configPath },
      { stdout: stdoutSink, stderr: stderrSink },
    );
    expect(readConfigFile(configPath)).toEqual({ httpHost: LOCAL_ONLY_HOST });
  });

  it('creates parent directories if the config path is nested under a missing dir', async () => {
    const configPath = path.join(workDir, 'a', 'b', 'config.json');
    await runConfigNetwork(
      { mode: 'local-only', configPath },
      { stdout: stdoutSink, stderr: stderrSink },
    );
    expect(readConfigFile(configPath)).toEqual({ httpHost: LOCAL_ONLY_HOST });
  });
});
