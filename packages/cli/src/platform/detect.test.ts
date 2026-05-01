import { describe, expect, it } from 'vitest';

import {
  detectPlatform,
  getDefaultConfigPath,
  getDefaultMacLogPaths,
  getDefaultUnitPath,
  getDefaultUser,
  getDefaultWorkingDir,
} from './detect.js';
import type { PlatformLike } from './detect.js';

import { CliError } from '../error/cli-error.js';

const linuxStub: PlatformLike = {
  platform: 'linux',
  homedir: () => '/root',
  env: {},
};

const darwinStub: PlatformLike = {
  platform: 'darwin',
  homedir: () => '/Users/leonardo',
  env: { USER: 'leonardo' },
};

const windowsStub: PlatformLike = {
  platform: 'win32',
  homedir: () => 'C:\\Users\\op',
  env: {},
};

describe('detectPlatform', () => {
  it('returns "linux" on linux', () => {
    expect(detectPlatform(linuxStub)).toBe('linux');
  });

  it('returns "darwin" on darwin', () => {
    expect(detectPlatform(darwinStub)).toBe('darwin');
  });

  it('throws UNSUPPORTED_PLATFORM on win32', () => {
    let caught: unknown;
    try {
      detectPlatform(windowsStub);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).code).toBe('UNSUPPORTED_PLATFORM');
    expect((caught as CliError).message).toContain('win32');
    expect((caught as CliError).message).toContain('deployment/README.md');
  });

  it('throws on freebsd / openbsd / sunos / aix (the other node platforms)', () => {
    for (const p of ['freebsd', 'openbsd', 'sunos', 'aix'] as const) {
      const stub: PlatformLike = { platform: p, homedir: () => '/home/op', env: {} };
      expect(() => detectPlatform(stub)).toThrow(CliError);
    }
  });
});

describe('getDefaultWorkingDir', () => {
  it('returns /var/lib/hive on linux', () => {
    expect(getDefaultWorkingDir(linuxStub)).toBe('/var/lib/hive');
  });

  it('returns ~/Library/Application Support/Hive on darwin', () => {
    expect(getDefaultWorkingDir(darwinStub)).toBe(
      '/Users/leonardo/Library/Application Support/Hive',
    );
  });

  it('throws on unsupported', () => {
    expect(() => getDefaultWorkingDir(windowsStub)).toThrow(CliError);
  });
});

describe('getDefaultUser', () => {
  it('returns "hive" on linux (dedicated system user — closes FLAG-002)', () => {
    expect(getDefaultUser(linuxStub)).toBe('hive');
  });

  it('returns $USER on darwin', () => {
    expect(getDefaultUser(darwinStub)).toBe('leonardo');
  });

  it('falls back to $LOGNAME if $USER is unset on darwin', () => {
    expect(
      getDefaultUser({
        platform: 'darwin',
        homedir: () => '/Users/op',
        env: { LOGNAME: 'op' },
      }),
    ).toBe('op');
  });

  it('falls back to "unknown" if neither $USER nor $LOGNAME is set on darwin', () => {
    expect(
      getDefaultUser({
        platform: 'darwin',
        homedir: () => '/Users/op',
        env: {},
      }),
    ).toBe('unknown');
  });
});

describe('getDefaultConfigPath', () => {
  it('returns /var/lib/hive/config.json on linux', () => {
    expect(getDefaultConfigPath(linuxStub)).toBe('/var/lib/hive/config.json');
  });

  it('returns ~/Library/Application Support/Hive/config.json on darwin', () => {
    expect(getDefaultConfigPath(darwinStub)).toBe(
      '/Users/leonardo/Library/Application Support/Hive/config.json',
    );
  });
});

describe('getDefaultUnitPath', () => {
  it('returns /etc/systemd/system/hive.service on linux', () => {
    expect(getDefaultUnitPath(linuxStub)).toBe('/etc/systemd/system/hive.service');
  });

  it('returns ~/Library/LaunchAgents/com.hivemine.hivectl.plist on darwin', () => {
    expect(getDefaultUnitPath(darwinStub)).toBe(
      '/Users/leonardo/Library/LaunchAgents/com.hivemine.hivectl.plist',
    );
  });
});

describe('getDefaultMacLogPaths', () => {
  it('returns hive.log + hive.err under ~/Library/Logs/Hive', () => {
    const paths = getDefaultMacLogPaths(darwinStub);
    expect(paths.stdoutPath).toBe('/Users/leonardo/Library/Logs/Hive/hive.log');
    expect(paths.stderrPath).toBe('/Users/leonardo/Library/Logs/Hive/hive.err');
  });

  it('throws on linux (no plist log paths there)', () => {
    expect(() => getDefaultMacLogPaths(linuxStub)).toThrow(CliError);
  });
});
