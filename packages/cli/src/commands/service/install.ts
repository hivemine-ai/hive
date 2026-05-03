// `hivectl service install` — writes the systemd unit (Linux) or launchd
// plist (Mac) pointing at `process.execPath`. Closes INC-2026-001 FLAG-002:
// Linux installs run the server under a dedicated `hive` system user.
//
// Per the hivectl + Admin Operations tech spec § "service install".

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { CliError } from '#error/cli-error.js';
import {
  detectPlatform,
  getDefaultMacLogPaths,
  getDefaultUnitPath,
  getDefaultUser,
  getDefaultWorkingDir,
  SYSTEMD_UNIT_NAME,
} from '#platform/detect.js';

import { runConfigNetwork } from '#commands/config/network.js';
import type { NetworkMode } from '#commands/config/network.js';

import { realProcessRunner } from './exec.js';
import type { ProcessRunner } from './exec.js';
import { renderLaunchdPlist, renderSystemdUnit } from './templates.js';

export interface RunServiceInstallInput {
  user?: string;
  workingDir?: string;
  bind?: NetworkMode;
}

export interface InstallPaths {
  unitPath: string;
  workingDir: string;
  /** Mac only — ignored on Linux. */
  stdoutPath?: string;
  /** Mac only — ignored on Linux. */
  stderrPath?: string;
  /** Optional config path override forwarded to `runConfigNetwork`. */
  configPath?: string;
}

export interface RunServiceInstallDeps {
  /** Defaults to `process.execPath`. */
  execPath?: string;
  /** Test seam — defaults to real spawnSync. */
  runner?: ProcessRunner;
  /** Test seam — defaults to checking `process.geteuid?.() === 0`. */
  isRoot?: () => boolean;
  /** Override default platform paths (test seam). */
  paths?: InstallPaths;
  /** Override the platform detector (test seam). */
  platform?: 'linux' | 'darwin';
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

export interface RunServiceInstallResult {
  unitPath: string;
  workingDir: string;
  user: string;
  supervisor: 'systemd' | 'launchd';
}

export async function runServiceInstall(
  input: RunServiceInstallInput,
  deps: RunServiceInstallDeps = {},
): Promise<RunServiceInstallResult> {
  const platform = deps.platform ?? detectPlatform();
  const execPath = deps.execPath ?? process.execPath;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const runner = deps.runner ?? realProcessRunner;

  if (input.bind !== undefined) {
    const cfgInput =
      deps.paths?.configPath !== undefined
        ? { mode: input.bind, configPath: deps.paths.configPath }
        : { mode: input.bind };
    await runConfigNetwork(cfgInput, { stdout, stderr });
  }

  if (platform === 'linux') {
    return installLinux(input, {
      execPath,
      runner,
      isRoot: deps.isRoot,
      stderr,
      paths: deps.paths,
    });
  }
  return installDarwin(input, { execPath, stderr, paths: deps.paths });
}

interface LinuxDeps {
  execPath: string;
  runner: ProcessRunner;
  isRoot: (() => boolean) | undefined;
  stderr: NodeJS.WritableStream;
  paths: InstallPaths | undefined;
}

function installLinux(input: RunServiceInstallInput, deps: LinuxDeps): RunServiceInstallResult {
  const isRoot = deps.isRoot ? deps.isRoot() : process.geteuid?.() === 0;
  if (!isRoot) {
    throw new CliError('ROOT_REQUIRED', {
      message: `'service install' on Linux must run as root. Try: sudo hivectl service install`,
    });
  }

  const user =
    input.user ?? getDefaultUser({ platform: 'linux', homedir: () => '/root', env: process.env });
  const workingDir =
    input.workingDir ??
    deps.paths?.workingDir ??
    getDefaultWorkingDir({ platform: 'linux', homedir: () => '/root', env: process.env });
  const unitPath =
    deps.paths?.unitPath ??
    getDefaultUnitPath({ platform: 'linux', homedir: () => '/root', env: process.env });

  ensureSystemUser(user, workingDir, deps.runner, deps.stderr);
  ensureWorkingDir(workingDir, user, deps.runner);

  if (existsSync(unitPath)) {
    deps.stderr.write(`warning: ${unitPath} exists; overwriting\n`);
  }
  const unit = renderSystemdUnit({ execPath: deps.execPath, workingDir, user });
  mkdirSync(path.dirname(unitPath), { recursive: true });
  writeFileSync(unitPath, unit, 'utf8');

  const reload = deps.runner.run('systemctl', ['daemon-reload']);
  if (reload.status !== 0) {
    throw new CliError('WORKING_DIR_PERMISSION', {
      message: `'systemctl daemon-reload' failed: ${(reload.stderr || reload.stdout).trim()}`,
    });
  }

  return { unitPath, workingDir, user, supervisor: 'systemd' };
}

function ensureSystemUser(
  user: string,
  workingDir: string,
  runner: ProcessRunner,
  stderr: NodeJS.WritableStream,
): void {
  // `id <user>` exits 0 if the user exists.
  const probe = runner.run('id', [user]);
  if (probe.status === 0) return;

  const which = runner.run('which', ['useradd']);
  if (which.status !== 0) {
    stderr.write(
      `warning: 'useradd' not found on this distro. Create user '${user}' manually,` +
        ` then re-run with --user <existing-user>.\n`,
    );
    return;
  }
  const create = runner.run('useradd', [
    '-r', // system user (no aging policy)
    '-s',
    '/bin/false',
    '-d',
    workingDir,
    user,
  ]);
  if (create.status !== 0) {
    throw new CliError('WORKING_DIR_PERMISSION', {
      message: `failed to create user '${user}': ${(create.stderr || create.stdout).trim()}`,
    });
  }
}

function ensureWorkingDir(workingDir: string, user: string, runner: ProcessRunner): void {
  mkdirSync(workingDir, { recursive: true, mode: 0o750 });
  const chown = runner.run('chown', [`${user}:${user}`, workingDir]);
  if (chown.status !== 0) {
    throw new CliError('WORKING_DIR_PERMISSION', {
      message: `failed to chown ${workingDir} to ${user}: ${(chown.stderr || chown.stdout).trim()}`,
    });
  }
}

interface DarwinDeps {
  execPath: string;
  stderr: NodeJS.WritableStream;
  paths: InstallPaths | undefined;
}

function installDarwin(input: RunServiceInstallInput, deps: DarwinDeps): RunServiceInstallResult {
  const darwinStub = {
    platform: 'darwin' as const,
    homedir: () => process.env['HOME'] ?? '/',
    env: process.env,
  };
  const user = input.user ?? getDefaultUser(darwinStub);
  const workingDir = input.workingDir ?? deps.paths?.workingDir ?? getDefaultWorkingDir(darwinStub);
  const unitPath = deps.paths?.unitPath ?? getDefaultUnitPath(darwinStub);
  const fallbackLogs = (() => {
    try {
      return getDefaultMacLogPaths(darwinStub);
    } catch {
      return { stdoutPath: '/tmp/hive.log', stderrPath: '/tmp/hive.err' };
    }
  })();
  const stdoutPath = deps.paths?.stdoutPath ?? fallbackLogs.stdoutPath;
  const stderrPath = deps.paths?.stderrPath ?? fallbackLogs.stderrPath;

  // Create working dir + log dir + plist parent.
  mkdirSync(workingDir, { recursive: true });
  mkdirSync(path.dirname(stdoutPath), { recursive: true });
  mkdirSync(path.dirname(unitPath), { recursive: true });

  if (existsSync(unitPath)) {
    deps.stderr.write(`warning: ${unitPath} exists; overwriting\n`);
  }
  const plist = renderLaunchdPlist({
    execPath: deps.execPath,
    workingDir,
    stdoutPath,
    stderrPath,
  });
  writeFileSync(unitPath, plist, 'utf8');

  return { unitPath, workingDir, user, supervisor: 'launchd' };
}

/**
 * Builds the post-install instructions printed to stdout. Pure — easy to test.
 */
export function renderInstallSuccess(result: RunServiceInstallResult): string {
  const lines: string[] = ['Service installed.', ''];
  lines.push(`  Unit path:   ${result.unitPath}`);
  lines.push(`  Working dir: ${result.workingDir}`);
  if (result.supervisor === 'systemd') {
    lines.push(`  User:        ${result.user}`);
  }
  lines.push('');
  lines.push('To start:');
  if (result.supervisor === 'systemd') {
    lines.push(
      `  sudo systemctl enable ${SYSTEMD_UNIT_NAME} && sudo systemctl start ${SYSTEMD_UNIT_NAME}`,
    );
    lines.push('  # Or: hivectl service start');
  } else {
    lines.push(`  launchctl load -w ${result.unitPath}`);
    lines.push('  # Or: hivectl service start');
  }
  return lines.join('\n');
}
