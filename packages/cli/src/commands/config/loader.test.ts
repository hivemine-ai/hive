import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readConfigFile, resolveHttpHost, writeConfigFile } from './loader.js';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'hive-config-test-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('readConfigFile', () => {
  it('returns null when the file does not exist', () => {
    expect(readConfigFile(path.join(workDir, 'missing.json'))).toBeNull();
  });

  it('returns the parsed object when the file exists', () => {
    const file = path.join(workDir, 'config.json');
    writeFileSync(file, JSON.stringify({ httpHost: '0.0.0.0' }), 'utf8');
    expect(readConfigFile(file)).toEqual({ httpHost: '0.0.0.0' });
  });

  it('throws on invalid JSON', () => {
    const file = path.join(workDir, 'config.json');
    writeFileSync(file, '{not-json', 'utf8');
    expect(() => readConfigFile(file)).toThrow(/invalid config file/);
  });

  it('throws on JSON arrays / null / strings (top-level not an object)', () => {
    for (const bad of ['[]', 'null', '"a"', '42']) {
      const file = path.join(workDir, `config-${bad.replace(/\W/g, '_')}.json`);
      writeFileSync(file, bad, 'utf8');
      expect(() => readConfigFile(file)).toThrow(/invalid config file/);
    }
  });
});

describe('writeConfigFile', () => {
  it('creates parent directories recursively', () => {
    const file = path.join(workDir, 'a', 'b', 'c', 'config.json');
    writeConfigFile(file, { httpHost: '127.0.0.1' });
    expect(readConfigFile(file)).toEqual({ httpHost: '127.0.0.1' });
  });

  it('overwrites an existing file', () => {
    const file = path.join(workDir, 'config.json');
    writeConfigFile(file, { httpHost: '127.0.0.1' });
    writeConfigFile(file, { httpHost: '0.0.0.0' });
    expect(readConfigFile(file)).toEqual({ httpHost: '0.0.0.0' });
  });

  it('writes pretty JSON ending with a trailing newline', () => {
    const file = path.join(workDir, 'config.json');
    writeConfigFile(file, { httpHost: '127.0.0.1' });
    // One trailing newline; pretty-printed (2-space indent).
    const raw = readFileSync(file, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toContain('  "httpHost": "127.0.0.1"');
  });
});

describe('resolveHttpHost', () => {
  it('flag wins over env wins over config wins over default', () => {
    expect(
      resolveHttpHost({
        flag: '10.0.0.1',
        env: '10.0.0.2',
        configFile: { httpHost: '10.0.0.3' },
      }),
    ).toBe('10.0.0.1');
    expect(
      resolveHttpHost({
        flag: undefined,
        env: '10.0.0.2',
        configFile: { httpHost: '10.0.0.3' },
      }),
    ).toBe('10.0.0.2');
    expect(
      resolveHttpHost({
        flag: undefined,
        env: undefined,
        configFile: { httpHost: '10.0.0.3' },
      }),
    ).toBe('10.0.0.3');
    expect(
      resolveHttpHost({
        flag: undefined,
        env: undefined,
        configFile: null,
      }),
    ).toBe('127.0.0.1');
  });

  it('treats env empty string as "unset" (skips to config)', () => {
    expect(
      resolveHttpHost({
        flag: undefined,
        env: '',
        configFile: { httpHost: '10.0.0.3' },
      }),
    ).toBe('10.0.0.3');
  });

  it('falls back to default when configFile.httpHost is undefined (config file exists, key missing)', () => {
    expect(resolveHttpHost({ flag: undefined, env: undefined, configFile: {} })).toBe('127.0.0.1');
  });
});
