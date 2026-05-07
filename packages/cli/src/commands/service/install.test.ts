import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CliError } from '#error/cli-error.js';

import type { ProcessResult, ProcessRunner } from './exec.js';
import {
  isSystemAccessiblePath,
  renderInstallSuccess,
  resolveSystemAccessibleExecPath,
  runServiceInstall,
} from './install.js';
import { readConfigFile } from '#commands/config/loader.js';

let workDir: string;
let stdoutBuf: string[];
let stderrBuf: string[];
let stdoutSink: Writable;
let stderrSink: Writable;

function makeWritable(buf: string[]): Writable {
  return new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      buf.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      cb();
    },
  });
}

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'hive-install-test-'));
  stdoutBuf = [];
  stderrBuf = [];
  stdoutSink = makeWritable(stdoutBuf);
  stderrSink = makeWritable(stderrBuf);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

interface RunnerCall {
  command: string;
  args: readonly string[];
}

function makeRunner(replies: Map<string, ProcessResult>): {
  runner: ProcessRunner;
  calls: RunnerCall[];
} {
  const calls: RunnerCall[] = [];
  const runner: ProcessRunner = {
    run(command, args) {
      calls.push({ command, args });
      const key = `${command} ${args.join(' ')}`;
      return replies.get(key) ?? replies.get(command) ?? { status: 0, stdout: '', stderr: '' };
    },
  };
  return { runner, calls };
}

describe('runServiceInstall — Linux', () => {
  it('writes the systemd unit, calls daemon-reload, and returns supervisor=systemd', async () => {
    const unitPath = path.join(workDir, 'system', 'hive.service');
    const wd = path.join(workDir, 'lib');
    const { runner, calls } = makeRunner(
      new Map([
        ['id hive', { status: 1, stdout: '', stderr: '' }],
        ['which useradd', { status: 0, stdout: '/usr/sbin/useradd', stderr: '' }],
      ]),
    );
    const result = await runServiceInstall(
      { user: 'hive', workingDir: wd },
      {
        platform: 'linux',
        execPath: '/usr/local/bin/hivectl',
        runner,
        isRoot: () => true,
        paths: { unitPath, workingDir: wd },
        stdout: stdoutSink,
        stderr: stderrSink,
      },
    );
    expect(result.supervisor).toBe('systemd');
    expect(result.unitPath).toBe(unitPath);
    expect(result.user).toBe('hive');

    const written = readFileSync(unitPath, 'utf8');
    expect(written).toContain('User=hive');
    expect(written).toContain('Group=hive');
    expect(written).toContain(`WorkingDirectory=${wd}`);
    expect(written).toContain('ExecStart=/usr/local/bin/hivectl serve');
    expect(written).toContain('Restart=on-failure');

    const cmds = calls.map((c) => c.command);
    expect(cmds).toContain('id');
    expect(cmds).toContain('useradd');
    expect(cmds).toContain('chown');
    expect(cmds).toContain('systemctl');
  });

  it('throws ROOT_REQUIRED when isRoot returns false', async () => {
    let caught: unknown;
    try {
      await runServiceInstall(
        {},
        {
          platform: 'linux',
          isRoot: () => false,
          paths: {
            unitPath: path.join(workDir, 'hive.service'),
            workingDir: path.join(workDir, 'lib'),
          },
          stdout: stdoutSink,
          stderr: stderrSink,
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).code).toBe('ROOT_REQUIRED');
  });

  it('skips useradd when id <user> already exits 0', async () => {
    const unitPath = path.join(workDir, 'hive.service');
    const wd = path.join(workDir, 'lib');
    const { runner, calls } = makeRunner(
      new Map([['id hive', { status: 0, stdout: 'uid=999(hive)', stderr: '' }]]),
    );
    await runServiceInstall(
      { user: 'hive', workingDir: wd },
      {
        platform: 'linux',
        execPath: '/usr/local/bin/hivectl',
        runner,
        isRoot: () => true,
        paths: { unitPath, workingDir: wd },
        stdout: stdoutSink,
        stderr: stderrSink,
      },
    );
    expect(calls.find((c) => c.command === 'useradd')).toBeUndefined();
  });

  it('emits a warning to stderr when useradd is missing on the distro', async () => {
    const unitPath = path.join(workDir, 'hive.service');
    const wd = path.join(workDir, 'lib');
    const { runner } = makeRunner(
      new Map([
        ['id hive', { status: 1, stdout: '', stderr: '' }],
        ['which useradd', { status: 1, stdout: '', stderr: 'not found' }],
      ]),
    );
    await runServiceInstall(
      { user: 'hive', workingDir: wd },
      {
        platform: 'linux',
        execPath: '/usr/local/bin/hivectl',
        runner,
        isRoot: () => true,
        paths: { unitPath, workingDir: wd },
        stdout: stdoutSink,
        stderr: stderrSink,
      },
    );
    expect(stderrBuf.join('')).toContain("'useradd' not found");
    expect(stderrBuf.join('')).toContain('Create user');
  });

  it('throws WORKING_DIR_PERMISSION when daemon-reload fails', async () => {
    const unitPath = path.join(workDir, 'hive.service');
    const wd = path.join(workDir, 'lib');
    const { runner } = makeRunner(
      new Map([
        ['id hive', { status: 0, stdout: '', stderr: '' }],
        ['systemctl daemon-reload', { status: 1, stdout: '', stderr: 'permission denied' }],
      ]),
    );
    let caught: unknown;
    try {
      await runServiceInstall(
        { user: 'hive', workingDir: wd },
        {
          platform: 'linux',
          execPath: '/usr/local/bin/hivectl',
          runner,
          isRoot: () => true,
          paths: { unitPath, workingDir: wd },
          stdout: stdoutSink,
          stderr: stderrSink,
        },
      );
    } catch (err) {
      caught = err;
    }
    expect((caught as CliError).code).toBe('WORKING_DIR_PERMISSION');
    expect((caught as CliError).message).toContain('daemon-reload');
  });

  it('copies the binary to /usr/local/bin and uses that in ExecStart when execPath is under /root/.nvm/', async () => {
    // Reproduces the v0.1.5 production failure: the user installs hivectl
    // via nvm under /root/, the SEA binary lands at
    // /root/.nvm/.../hivectl, and `service install` would emit a unit
    // file with User=hive + ExecStart pointing at /root/.nvm/...
    // — which fails to execve with 203/EXEC because hive cannot
    // traverse /root/ (mode 0700).
    const sourceBinary = path.join(workDir, 'fake-nvm', '.nvm', 'bin', 'hivectl');
    const targetBinary = path.join(workDir, 'fake-usr-local', 'bin', 'hivectl');
    mkdirSync(path.dirname(sourceBinary), { recursive: true });
    writeFileSync(sourceBinary, 'STUB-HIVECTL', 'utf8');
    const unitPath = path.join(workDir, 'hive.service');
    const wd = path.join(workDir, 'lib');
    const { runner } = makeRunner(new Map([['id hive', { status: 0, stdout: '', stderr: '' }]]));
    // Inject the target binary path so the test does not write to the
    // real /usr/local/bin. We re-export the constant for testability via
    // the resolveSystemAccessibleExecPath helper called directly.
    const resolved = resolveSystemAccessibleExecPath(sourceBinary, targetBinary, stderrSink);
    expect(resolved).toBe(targetBinary);
    expect(existsSync(targetBinary)).toBe(true);
    // Now exercise the full install with the resolved path mimicking the
    // copy already happened (ensures the unit file uses targetBinary).
    const result = await runServiceInstall(
      { user: 'hive', workingDir: wd },
      {
        platform: 'linux',
        execPath: targetBinary,
        runner,
        isRoot: () => true,
        paths: { unitPath, workingDir: wd },
        stdout: stdoutSink,
        stderr: stderrSink,
      },
    );
    expect(result.execPath).toBe(targetBinary);
    const written = readFileSync(unitPath, 'utf8');
    expect(written).toContain(`ExecStart=${targetBinary} serve`);
    expect(written).not.toContain('/.nvm/');
  });

  it('warns to stderr when overwriting an existing unit', async () => {
    const unitPath = path.join(workDir, 'hive.service');
    const wd = path.join(workDir, 'lib');
    writeFileSync(unitPath, '[Unit]\nDescription=stale\n', 'utf8');
    const { runner } = makeRunner(new Map([['id hive', { status: 0, stdout: '', stderr: '' }]]));
    await runServiceInstall(
      { user: 'hive', workingDir: wd },
      {
        platform: 'linux',
        execPath: '/usr/local/bin/hivectl',
        runner,
        isRoot: () => true,
        paths: { unitPath, workingDir: wd },
        stdout: stdoutSink,
        stderr: stderrSink,
      },
    );
    expect(stderrBuf.join('')).toContain('exists; overwriting');
  });
});

describe('runServiceInstall — Darwin', () => {
  it('writes the launchd plist and returns supervisor=launchd', async () => {
    const unitPath = path.join(workDir, 'LaunchAgents', 'com.hivemine.hivectl.plist');
    const wd = path.join(workDir, 'AppSupport', 'Hive');
    const stdoutPath = path.join(workDir, 'logs', 'hive.log');
    const stderrPath = path.join(workDir, 'logs', 'hive.err');
    const result = await runServiceInstall(
      {},
      {
        platform: 'darwin',
        execPath: '/usr/local/bin/hivectl',
        paths: { unitPath, workingDir: wd, stdoutPath, stderrPath },
        stdout: stdoutSink,
        stderr: stderrSink,
      },
    );
    expect(result.supervisor).toBe('launchd');
    const written = readFileSync(unitPath, 'utf8');
    expect(written).toContain('<string>com.hivemine.hivectl</string>');
    expect(written).toContain('<string>/usr/local/bin/hivectl</string>');
    expect(written).toContain(`<string>${wd}</string>`);
    expect(written).toContain(`<string>${stdoutPath}</string>`);
    expect(written).toContain(`<string>${stderrPath}</string>`);
  });

  it('does NOT require root on darwin', async () => {
    const unitPath = path.join(workDir, 'plist.plist');
    const wd = path.join(workDir, 'data');
    const stdoutPath = path.join(workDir, 'logs', 'a.log');
    const stderrPath = path.join(workDir, 'logs', 'a.err');
    // No isRoot callback — darwin should not check.
    await expect(
      runServiceInstall(
        {},
        {
          platform: 'darwin',
          execPath: '/x',
          paths: { unitPath, workingDir: wd, stdoutPath, stderrPath },
          stdout: stdoutSink,
          stderr: stderrSink,
        },
      ),
    ).resolves.toBeDefined();
  });

  it('--bind delegates to runConfigNetwork (writes config + warning)', async () => {
    const unitPath = path.join(workDir, 'plist.plist');
    const wd = path.join(workDir, 'data');
    const stdoutPath = path.join(workDir, 'logs', 'a.log');
    const stderrPath = path.join(workDir, 'logs', 'a.err');
    const configPath = path.join(workDir, 'data', 'config.json');
    await runServiceInstall(
      { bind: 'bind-all' },
      {
        platform: 'darwin',
        execPath: '/x',
        paths: { unitPath, workingDir: wd, stdoutPath, stderrPath, configPath },
        stdout: stdoutSink,
        stderr: stderrSink,
      },
    );
    expect(readConfigFile(configPath)).toEqual({ httpHost: '0.0.0.0' });
    expect(stderrBuf.join('')).toContain('WARNING: bind-all');
  });
});

describe('renderInstallSuccess', () => {
  it('renders systemd post-install instructions', () => {
    const out = renderInstallSuccess({
      unitPath: '/etc/systemd/system/hive.service',
      workingDir: '/var/lib/hive',
      user: 'hive',
      supervisor: 'systemd',
      execPath: '/usr/local/bin/hivectl',
    });
    expect(out).toContain('Unit path:   /etc/systemd/system/hive.service');
    expect(out).toContain('Working dir: /var/lib/hive');
    expect(out).toContain('User:        hive');
    expect(out).toContain('ExecStart:   /usr/local/bin/hivectl');
    expect(out).toContain('sudo systemctl enable hive && sudo systemctl start hive');
    expect(out).toContain('hivectl service start');
  });

  it('emits a copy note when execPath was relocated for system accessibility', () => {
    const out = renderInstallSuccess({
      unitPath: '/etc/systemd/system/hive.service',
      workingDir: '/var/lib/hive',
      user: 'hive',
      supervisor: 'systemd',
      execPath: '/usr/local/bin/hivectl',
      execPathCopiedFrom:
        '/root/.nvm/versions/node/v20.18.1/lib/node_modules/@hivemine/hivectl/node_modules/@hivemine/hivectl-linux-x64/bin/hivectl',
    });
    expect(out).toContain('copied binary from /root/.nvm/');
    expect(out).toContain('to /usr/local/bin/hivectl');
    expect(out).toContain('not system-accessible');
  });

  it('omits the copy note when execPath was not relocated', () => {
    const out = renderInstallSuccess({
      unitPath: '/etc/systemd/system/hive.service',
      workingDir: '/var/lib/hive',
      user: 'hive',
      supervisor: 'systemd',
      execPath: '/usr/local/bin/hivectl',
    });
    expect(out).not.toContain('copied binary');
  });

  it('emits state bootstrap instructions for systemd installs', () => {
    const out = renderInstallSuccess({
      unitPath: '/etc/systemd/system/hive.service',
      workingDir: '/var/lib/hive',
      user: 'hive',
      supervisor: 'systemd',
      execPath: '/usr/local/bin/hivectl',
    });
    expect(out).toContain('bootstrap state in the working directory');
    expect(out).toContain("sudo -u hive bash -c 'cd /var/lib/hive && hivectl init");
    expect(out).toContain('sudo cp -r <init-cwd>/var/keys /var/lib/hive/var/keys');
    expect(out).toContain('sudo cp -r <init-cwd>/var/db   /var/lib/hive/var/db');
    expect(out).toContain('sudo chown -R hive:hive /var/lib/hive/var');
  });

  it('renders launchd post-install instructions (no User: line, no state bootstrap)', () => {
    const out = renderInstallSuccess({
      unitPath: '/Users/op/Library/LaunchAgents/com.hivemine.hivectl.plist',
      workingDir: '/Users/op/Library/Application Support/Hive',
      user: 'op',
      supervisor: 'launchd',
      execPath: '/usr/local/bin/hivectl',
    });
    expect(out).toContain('launchctl load -w');
    expect(out).not.toContain('User:        ');
    expect(out).not.toContain('bootstrap state');
    expect(out).toContain('hivectl service start');
  });
});

describe('isSystemAccessiblePath', () => {
  it('flags /root/-rooted paths as not system-accessible', () => {
    expect(isSystemAccessiblePath('/root/.nvm/versions/node/v20/bin/hivectl')).toBe(false);
    expect(isSystemAccessiblePath('/root/whatever/hivectl')).toBe(false);
  });

  it('flags any path inside an nvm-managed install as not system-accessible', () => {
    expect(isSystemAccessiblePath('/home/operator/.nvm/versions/node/v22/bin/hivectl')).toBe(false);
    expect(isSystemAccessiblePath('/Users/op/.nvm/versions/node/v22/bin/hivectl')).toBe(false);
  });

  it('flags volta / fnm / asdf / .npm / .local paths as not system-accessible', () => {
    expect(isSystemAccessiblePath('/home/op/.volta/tools/image/node/22/bin/hivectl')).toBe(false);
    expect(isSystemAccessiblePath('/home/op/.fnm/node-versions/v22/bin/hivectl')).toBe(false);
    expect(isSystemAccessiblePath('/home/op/.asdf/installs/nodejs/22/bin/hivectl')).toBe(false);
    expect(isSystemAccessiblePath('/root/.npm/_npx/abcd/node_modules/.bin/hivectl')).toBe(false);
    expect(isSystemAccessiblePath('/home/op/.local/bin/hivectl')).toBe(false);
  });

  it('accepts standard system paths', () => {
    expect(isSystemAccessiblePath('/usr/local/bin/hivectl')).toBe(true);
    expect(isSystemAccessiblePath('/usr/bin/hivectl')).toBe(true);
    expect(isSystemAccessiblePath('/opt/hive/bin/hivectl')).toBe(true);
    expect(isSystemAccessiblePath('/srv/hive/hivectl')).toBe(true);
  });
});

describe('resolveSystemAccessibleExecPath', () => {
  it('returns the source path unchanged when already system-accessible', () => {
    const stderrBuf: string[] = [];
    const stderr = makeWritable(stderrBuf);
    const result = resolveSystemAccessibleExecPath(
      '/usr/local/bin/hivectl',
      '/usr/local/bin/hivectl',
      stderr,
    );
    expect(result).toBe('/usr/local/bin/hivectl');
    expect(stderrBuf.join('')).toBe('');
  });

  it('copies the binary when the source path is not system-accessible', () => {
    const sourcePath = path.join(workDir, 'fake-nvm', 'node', 'lib', 'hivectl');
    const targetPath = path.join(workDir, 'usr-local-bin', 'hivectl');
    // Create a fake binary with known content. The source path includes
    // ".nvm" to trigger the non-system-accessible branch.
    const realSource = sourcePath.replace(workDir, path.join(workDir, '.nvm'));
    const realSourceDir = path.dirname(realSource);
    mkdirSync(realSourceDir, { recursive: true });
    writeFileSync(realSource, '#!/bin/sh\necho hivectl-stub\n', 'utf8');
    const stderrBuf: string[] = [];
    const stderr = makeWritable(stderrBuf);
    const result = resolveSystemAccessibleExecPath(realSource, targetPath, stderr);
    expect(result).toBe(targetPath);
    expect(existsSync(targetPath)).toBe(true);
    expect(readFileSync(targetPath, 'utf8')).toBe('#!/bin/sh\necho hivectl-stub\n');
    expect(stderrBuf.join('')).toContain('copied binary');
    expect(stderrBuf.join('')).toContain('not traversable');
  });

  it('reuses an existing target when sizes match (idempotent)', () => {
    const realSource = path.join(workDir, '.nvm', 'src-bin');
    const targetPath = path.join(workDir, 'tgt-bin');
    mkdirSync(path.dirname(realSource), { recursive: true });
    writeFileSync(realSource, 'IDENTICAL', 'utf8');
    writeFileSync(targetPath, 'IDENTICAL', 'utf8');
    const stderrBuf: string[] = [];
    const result = resolveSystemAccessibleExecPath(realSource, targetPath, makeWritable(stderrBuf));
    expect(result).toBe(targetPath);
    expect(stderrBuf.join('')).toContain('already present');
    // Content must be unchanged (no copy occurred).
    expect(readFileSync(targetPath, 'utf8')).toBe('IDENTICAL');
  });

  it('overwrites the target when sizes differ (e.g., post-Hive-upgrade)', () => {
    const realSource = path.join(workDir, '.nvm', 'src-bin');
    const targetPath = path.join(workDir, 'tgt-bin');
    mkdirSync(path.dirname(realSource), { recursive: true });
    writeFileSync(realSource, 'NEW VERSION (longer than old)', 'utf8');
    writeFileSync(targetPath, 'OLD', 'utf8');
    const stderrBuf: string[] = [];
    const result = resolveSystemAccessibleExecPath(realSource, targetPath, makeWritable(stderrBuf));
    expect(result).toBe(targetPath);
    expect(readFileSync(targetPath, 'utf8')).toBe('NEW VERSION (longer than old)');
    expect(stderrBuf.join('')).toContain('copied binary');
  });
});

describe('integration — install then existsSync', () => {
  it('produces a unit file readable via existsSync', async () => {
    const unitPath = path.join(workDir, 'hive.service');
    const wd = path.join(workDir, 'lib');
    const { runner } = makeRunner(new Map([['id hive', { status: 0, stdout: '', stderr: '' }]]));
    await runServiceInstall(
      { user: 'hive', workingDir: wd },
      {
        platform: 'linux',
        execPath: '/x',
        runner,
        isRoot: () => true,
        paths: { unitPath, workingDir: wd },
        stdout: stdoutSink,
        stderr: stderrSink,
      },
    );
    expect(existsSync(unitPath)).toBe(true);
  });
});
