import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CliError } from '#error/cli-error.js';

import type { ProcessResult, ProcessRunner } from './exec.js';
import { renderInstallSuccess, runServiceInstall } from './install.js';
import { readConfigFile } from '../config/loader.js';

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
    });
    expect(out).toContain('Unit path:   /etc/systemd/system/hive.service');
    expect(out).toContain('Working dir: /var/lib/hive');
    expect(out).toContain('User:        hive');
    expect(out).toContain('sudo systemctl enable hive && sudo systemctl start hive');
    expect(out).toContain('hivectl service start');
  });

  it('renders launchd post-install instructions (no User: line)', () => {
    const out = renderInstallSuccess({
      unitPath: '/Users/op/Library/LaunchAgents/com.hivemine.hivectl.plist',
      workingDir: '/Users/op/Library/Application Support/Hive',
      user: 'op',
      supervisor: 'launchd',
    });
    expect(out).toContain('launchctl load -w');
    expect(out).not.toContain('User:        ');
    expect(out).toContain('hivectl service start');
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
