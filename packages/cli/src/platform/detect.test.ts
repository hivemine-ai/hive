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

import { CliError } from '#error/cli-error.js';

const linuxStub: PlatformLike = {
  platform: 'linux',
  homedir: () => '/root',
  env: {},
  cwd: () => '/root/test',
};

const darwinStub: PlatformLike = {
  platform: 'darwin',
  homedir: () => '/Users/leonardo',
  env: { USER: 'leonardo' },
  cwd: () => '/Users/leonardo/work/hive',
};

const windowsStub: PlatformLike = {
  platform: 'win32',
  homedir: () => 'C:\\Users\\op',
  env: {},
  cwd: () => 'C:\\Users\\op\\hive',
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
      const stub: PlatformLike = {
        platform: p,
        homedir: () => '/home/op',
        env: {},
        cwd: () => '/home/op',
      };
      expect(() => detectPlatform(stub)).toThrow(CliError);
    }
  });
});

describe('getDefaultWorkingDir', () => {
  it('returns the invoking process cwd on linux (PRY-069)', () => {
    expect(getDefaultWorkingDir(linuxStub)).toBe('/root/test');
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
  it('returns SUDO_USER on linux when set (the operator who invoked sudo)', () => {
    const stub: PlatformLike = {
      platform: 'linux',
      homedir: () => '/root',
      env: { SUDO_USER: 'leonardo', USER: 'root' },
      cwd: () => '/home/leonardo/hive',
    };
    expect(getDefaultUser(stub)).toBe('leonardo');
  });

  it('falls back to USER on linux when SUDO_USER is not set (e.g. logged in as root directly)', () => {
    const stub: PlatformLike = {
      platform: 'linux',
      homedir: () => '/root',
      env: { USER: 'root' },
      cwd: () => '/root/test',
    };
    expect(getDefaultUser(stub)).toBe('root');
  });

  it('falls back to LOGNAME on linux when USER is also unset', () => {
    const stub: PlatformLike = {
      platform: 'linux',
      homedir: () => '/root',
      env: { LOGNAME: 'op' },
      cwd: () => '/root/test',
    };
    expect(getDefaultUser(stub)).toBe('op');
  });

  it('falls back to "root" on linux when nothing is set (containers, init scripts)', () => {
    expect(getDefaultUser(linuxStub)).toBe('root');
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
        cwd: () => '/Users/op',
      }),
    ).toBe('op');
  });

  it('falls back to "unknown" if neither $USER nor $LOGNAME is set on darwin', () => {
    expect(
      getDefaultUser({
        platform: 'darwin',
        homedir: () => '/Users/op',
        env: {},
        cwd: () => '/Users/op',
      }),
    ).toBe('unknown');
  });
});

describe('getDefaultConfigPath', () => {
  it('returns <cwd>/config.json on linux (sibling of the working dir)', () => {
    expect(getDefaultConfigPath(linuxStub)).toBe('/root/test/config.json');
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
