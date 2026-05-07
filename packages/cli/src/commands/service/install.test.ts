import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CliError } from '#error/cli-error.js';

import type { ProcessResult, ProcessRunner } from './exec.js';
import {
  findPlatformPackageRoot,
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

  it('relocates the WHOLE platform package and uses the relocated binary in ExecStart when execPath is under /root/.nvm/', async () => {
    // Reproduces the v0.1.5/v0.1.7/v0.1.8 production chain: the binary
    // alone gets copied to a system path but the bundled
    // node_modules/better-sqlite3 stays behind, so the SEA's
    // createRequire chain fails with "Cannot find module
    // 'better-sqlite3'" at first DB-touching command. PRY-070 fixes
    // this by copying the whole platform package directory.
    const fakePkgRoot = path.join(workDir, 'fake-nvm', '.nvm', 'pkg');
    mkdirSync(path.join(fakePkgRoot, 'bin'), { recursive: true });
    mkdirSync(path.join(fakePkgRoot, 'node_modules', 'better-sqlite3', 'build', 'Release'), {
      recursive: true,
    });
    writeFileSync(path.join(fakePkgRoot, 'bin', 'hivectl'), 'STUB-HIVECTL', 'utf8');
    writeFileSync(
      path.join(fakePkgRoot, 'node_modules', 'better-sqlite3', 'package.json'),
      '{"name":"better-sqlite3"}',
      'utf8',
    );
    writeFileSync(
      path.join(
        fakePkgRoot,
        'node_modules',
        'better-sqlite3',
        'build',
        'Release',
        'better_sqlite3.node',
      ),
      'STUB-BINDING',
      'utf8',
    );
    writeFileSync(
      path.join(fakePkgRoot, 'package.json'),
      '{"name":"@hivemine/hivectl-stub","version":"0.0.0"}',
      'utf8',
    );

    const sourceBinary = path.join(fakePkgRoot, 'bin', 'hivectl');
    const targetPkg = path.join(workDir, 'system-lib', 'hivemine-hivectl');
    const targetBin = path.join(workDir, 'system-bin', 'hivectl');

    // Direct test of the resolver before exercising the full install.
    const stderrBuf: string[] = [];
    const resolved = resolveSystemAccessibleExecPath(
      sourceBinary,
      targetPkg,
      targetBin,
      makeWritable(stderrBuf),
    );
    expect(resolved).toBe(path.join(targetPkg, 'bin', 'hivectl'));
    // Bundled deps were copied with the binary — this is the regression PRY-070 fixes.
    expect(
      existsSync(
        path.join(
          targetPkg,
          'node_modules',
          'better-sqlite3',
          'build',
          'Release',
          'better_sqlite3.node',
        ),
      ),
    ).toBe(true);

    // Full install end-to-end: feed the resolved path back as execPath
    // and ensure the unit references it.
    const unitPath = path.join(workDir, 'hive.service');
    const wd = path.join(workDir, 'lib');
    const { runner } = makeRunner(new Map([['id hive', { status: 0, stdout: '', stderr: '' }]]));
    const result = await runServiceInstall(
      { user: 'hive', workingDir: wd },
      {
        platform: 'linux',
        execPath: resolved,
        runner,
        isRoot: () => true,
        paths: { unitPath, workingDir: wd },
        stdout: stdoutSink,
        stderr: stderrSink,
      },
    );
    expect(result.execPath).toBe(resolved);
    const written = readFileSync(unitPath, 'utf8');
    expect(written).toContain(`ExecStart=${resolved} serve`);
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

  it('emits a not-initialized hint when workingDir/var/keys is missing', () => {
    // workDir is a fresh tmp dir without any var/keys → renderInstallSuccess
    // should warn the operator to run `hivectl init` first.
    const out = renderInstallSuccess({
      unitPath: '/etc/systemd/system/hive.service',
      workingDir: workDir,
      user: 'leonardo',
      supervisor: 'systemd',
      execPath: '/usr/local/bin/hivectl',
    });
    expect(out).toContain('State:       not yet initialized');
    expect(out).toContain(`${workDir}/var/`);
    expect(out).toContain("Run 'hivectl init");
  });

  it('confirms state when workingDir/var/keys exists', () => {
    // Pre-create var/keys in the tmp workdir.
    mkdirSync(path.join(workDir, 'var', 'keys'), { recursive: true });
    const out = renderInstallSuccess({
      unitPath: '/etc/systemd/system/hive.service',
      workingDir: workDir,
      user: 'leonardo',
      supervisor: 'systemd',
      execPath: '/usr/local/bin/hivectl',
    });
    expect(out).toContain(`State:       found at ${path.join(workDir, 'var', 'keys')}`);
    expect(out).not.toContain('not yet initialized');
  });

  it('renders launchd post-install instructions (no User: line, no state hint)', () => {
    const out = renderInstallSuccess({
      unitPath: '/Users/op/Library/LaunchAgents/com.hivemine.hivectl.plist',
      workingDir: '/Users/op/Library/Application Support/Hive',
      user: 'op',
      supervisor: 'launchd',
      execPath: '/usr/local/bin/hivectl',
    });
    expect(out).toContain('launchctl load -w');
    expect(out).not.toContain('User:        ');
    expect(out).not.toContain('State:');
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
  // Helper: build a fake platform package layout under `dirRoot`, return
  // the path to the binary inside. Mirrors what npm install actually
  // produces:
  //   <dirRoot>/bin/hivectl                    (binary)
  //   <dirRoot>/native/better_sqlite3.node     (PRY-067 backup)
  //   <dirRoot>/node_modules/better-sqlite3/...
  //   <dirRoot>/node_modules/bindings/...
  //   <dirRoot>/package.json
  function makeFakePlatformPackage(dirRoot: string, binaryContent: string): string {
    mkdirSync(path.join(dirRoot, 'bin'), { recursive: true });
    mkdirSync(path.join(dirRoot, 'native'), { recursive: true });
    mkdirSync(path.join(dirRoot, 'node_modules', 'better-sqlite3', 'build', 'Release'), {
      recursive: true,
    });
    mkdirSync(path.join(dirRoot, 'node_modules', 'bindings'), { recursive: true });
    writeFileSync(path.join(dirRoot, 'bin', 'hivectl'), binaryContent, 'utf8');
    writeFileSync(path.join(dirRoot, 'native', 'better_sqlite3.node'), 'STUB-NODE', 'utf8');
    writeFileSync(
      path.join(dirRoot, 'node_modules', 'better-sqlite3', 'package.json'),
      '{"name":"better-sqlite3"}',
      'utf8',
    );
    writeFileSync(
      path.join(
        dirRoot,
        'node_modules',
        'better-sqlite3',
        'build',
        'Release',
        'better_sqlite3.node',
      ),
      'STUB-BINDING',
      'utf8',
    );
    writeFileSync(
      path.join(dirRoot, 'node_modules', 'bindings', 'package.json'),
      '{"name":"bindings"}',
      'utf8',
    );
    writeFileSync(
      path.join(dirRoot, 'package.json'),
      '{"name":"@hivemine/hivectl-stub","version":"0.0.0"}',
      'utf8',
    );
    return path.join(dirRoot, 'bin', 'hivectl');
  }

  it('returns the source path unchanged when already system-accessible', () => {
    const stderrBuf: string[] = [];
    const stderr = makeWritable(stderrBuf);
    const result = resolveSystemAccessibleExecPath(
      '/usr/local/bin/hivectl',
      path.join(workDir, 'usr-local-lib-pkg'),
      path.join(workDir, 'usr-local-bin-symlink'),
      stderr,
    );
    expect(result).toBe('/usr/local/bin/hivectl');
    expect(stderrBuf.join('')).toBe('');
  });

  it('copies the WHOLE platform package and creates a bin symlink when source is not system-accessible', () => {
    const fakePkgRoot = path.join(workDir, '.nvm', 'pkg');
    const sourceBinary = makeFakePlatformPackage(fakePkgRoot, '#!/bin/sh\necho hivectl-stub\n');
    const targetPkg = path.join(workDir, 'system-lib', 'hivemine-hivectl');
    const targetBin = path.join(workDir, 'system-bin', 'hivectl');
    const stderrBuf: string[] = [];
    const result = resolveSystemAccessibleExecPath(
      sourceBinary,
      targetPkg,
      targetBin,
      makeWritable(stderrBuf),
    );

    // The returned path is the binary inside the relocated package.
    expect(result).toBe(path.join(targetPkg, 'bin', 'hivectl'));

    // Whole package was copied — not just the binary.
    expect(existsSync(path.join(targetPkg, 'bin', 'hivectl'))).toBe(true);
    expect(existsSync(path.join(targetPkg, 'native', 'better_sqlite3.node'))).toBe(true);
    expect(existsSync(path.join(targetPkg, 'node_modules', 'better-sqlite3', 'package.json'))).toBe(
      true,
    );
    expect(
      existsSync(
        path.join(
          targetPkg,
          'node_modules',
          'better-sqlite3',
          'build',
          'Release',
          'better_sqlite3.node',
        ),
      ),
    ).toBe(true);
    expect(existsSync(path.join(targetPkg, 'node_modules', 'bindings', 'package.json'))).toBe(true);
    expect(existsSync(path.join(targetPkg, 'package.json'))).toBe(true);

    // Bin symlink points (relative) at the relocated binary.
    expect(existsSync(targetBin)).toBe(true);
    expect(lstatSync(targetBin).isSymbolicLink()).toBe(true);

    expect(stderrBuf.join('')).toContain('copied platform package');
    expect(stderrBuf.join('')).toContain('createRequire chain');
    expect(stderrBuf.join('')).toContain('bin symlink');
  });

  it('reuses an existing relocated package when sizes match (idempotent)', () => {
    const fakePkgRoot = path.join(workDir, '.nvm', 'pkg');
    const sourceBinary = makeFakePlatformPackage(fakePkgRoot, 'IDENTICAL');
    const targetPkg = path.join(workDir, 'system-lib', 'hivemine-hivectl');
    const targetBin = path.join(workDir, 'system-bin', 'hivectl');
    // Pre-populate the target as if a prior install had run.
    mkdirSync(path.join(targetPkg, 'bin'), { recursive: true });
    writeFileSync(path.join(targetPkg, 'bin', 'hivectl'), 'IDENTICAL', 'utf8');

    const stderrBuf: string[] = [];
    const result = resolveSystemAccessibleExecPath(
      sourceBinary,
      targetPkg,
      targetBin,
      makeWritable(stderrBuf),
    );
    expect(result).toBe(path.join(targetPkg, 'bin', 'hivectl'));
    expect(stderrBuf.join('')).toContain('already present');
    // Content unchanged (no recursive copy occurred).
    expect(readFileSync(path.join(targetPkg, 'bin', 'hivectl'), 'utf8')).toBe('IDENTICAL');
    // Symlink still gets ensured even on the reuse path.
    expect(existsSync(targetBin)).toBe(true);
  });

  it('overwrites the relocated package when binary sizes differ (Hive upgrade)', () => {
    const fakePkgRoot = path.join(workDir, '.nvm', 'pkg');
    const sourceBinary = makeFakePlatformPackage(
      fakePkgRoot,
      'NEW BINARY (much longer than the old stub binary)',
    );
    const targetPkg = path.join(workDir, 'system-lib', 'hivemine-hivectl');
    const targetBin = path.join(workDir, 'system-bin', 'hivectl');
    // Pre-populate target with an older smaller binary + a stale file
    // that should be removed on upgrade.
    mkdirSync(path.join(targetPkg, 'bin'), { recursive: true });
    writeFileSync(path.join(targetPkg, 'bin', 'hivectl'), 'OLD', 'utf8');
    writeFileSync(path.join(targetPkg, 'STALE-FILE-FROM-PRIOR-VERSION'), 'STALE', 'utf8');

    const stderrBuf: string[] = [];
    resolveSystemAccessibleExecPath(sourceBinary, targetPkg, targetBin, makeWritable(stderrBuf));
    // New binary is in place.
    expect(readFileSync(path.join(targetPkg, 'bin', 'hivectl'), 'utf8')).toBe(
      'NEW BINARY (much longer than the old stub binary)',
    );
    // Stale file from the prior install was removed by the rmSync before cpSync.
    expect(existsSync(path.join(targetPkg, 'STALE-FILE-FROM-PRIOR-VERSION'))).toBe(false);
    expect(stderrBuf.join('')).toContain('copied platform package');
  });

  it('throws when the source binary is not inside an npm package layout', () => {
    // No package.json two levels up from the binary → cannot relocate
    // safely without breaking the createRequire chain.
    const orphanBinary = path.join(workDir, '.nvm', 'orphan-hivectl');
    mkdirSync(path.dirname(orphanBinary), { recursive: true });
    writeFileSync(orphanBinary, 'standalone-binary-no-package', 'utf8');
    expect(() =>
      resolveSystemAccessibleExecPath(
        orphanBinary,
        path.join(workDir, 'system-lib', 'pkg'),
        path.join(workDir, 'system-bin', 'hivectl'),
        makeWritable([]),
      ),
    ).toThrow(/Cannot locate platform package root/);
  });
});

describe('findPlatformPackageRoot', () => {
  it('returns the parent of bin/ when package.json is present', () => {
    const root = path.join(workDir, 'pkg');
    mkdirSync(path.join(root, 'bin'), { recursive: true });
    writeFileSync(path.join(root, 'package.json'), '{}', 'utf8');
    const binary = path.join(root, 'bin', 'hivectl');
    writeFileSync(binary, '', 'utf8');
    expect(findPlatformPackageRoot(binary)).toBe(root);
  });

  it('throws when no package.json sits two levels up', () => {
    const orphan = path.join(workDir, 'somewhere', 'hivectl');
    mkdirSync(path.dirname(orphan), { recursive: true });
    writeFileSync(orphan, '', 'utf8');
    expect(() => findPlatformPackageRoot(orphan)).toThrow(/Cannot locate/);
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
