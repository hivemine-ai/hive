// `hivectl service install` — writes the systemd unit (Linux) or launchd
// plist (Mac) pointing at `process.execPath`. Closes INC-2026-001 FLAG-002:
// Linux installs run the server under a dedicated `hive` system user.
//
// Per the hivectl + Admin Operations tech spec § "service install".

import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
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
  /**
   * The path written into the unit's `ExecStart`. May differ from the
   * input `execPath` if the install copied the binary to
   * `/usr/local/bin/hivectl` to make it traversable by the service user.
   */
  execPath?: string;
  /**
   * If the install copied the binary to make it system-accessible, the
   * original source path. Used by the post-install instructions to
   * explain what was done.
   */
  execPathCopiedFrom?: string;
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

  // Resolve a system-accessible ExecStart path. The unit file declares
  // `User=<user>` (typically `hive`); when the binary lives under `/root/`,
  // `~/.nvm/`, or any user dotdir, the non-root system user cannot
  // traverse to it (mode 0700) and systemd fails with `203/EXEC Permission
  // denied`. If the source path is not system-accessible, copy the binary
  // to `/usr/local/bin/hivectl` and use that path in ExecStart.
  const resolvedExecPath = resolveSystemAccessibleExecPath(
    deps.execPath,
    SYSTEM_BINARY_TARGET,
    deps.stderr,
  );

  if (existsSync(unitPath)) {
    deps.stderr.write(`warning: ${unitPath} exists; overwriting\n`);
  }
  const unit = renderSystemdUnit({ execPath: resolvedExecPath, workingDir, user });
  mkdirSync(path.dirname(unitPath), { recursive: true });
  writeFileSync(unitPath, unit, 'utf8');

  const reload = deps.runner.run('systemctl', ['daemon-reload']);
  if (reload.status !== 0) {
    throw new CliError('WORKING_DIR_PERMISSION', {
      message: `'systemctl daemon-reload' failed: ${(reload.stderr || reload.stdout).trim()}`,
    });
  }

  const result: RunServiceInstallResult = {
    unitPath,
    workingDir,
    user,
    supervisor: 'systemd',
    execPath: resolvedExecPath,
  };
  if (resolvedExecPath !== deps.execPath) {
    result.execPathCopiedFrom = deps.execPath;
  }
  return result;
}

/**
 * Path patterns that are not safely traversable by non-root system users.
 * `/root/` is mode 0700 by default; user dotdirs (`~/.nvm/`, `~/.npm/`,
 * `~/.local/`) inherit restrictive permissions from `~/`. A unit file that
 * runs as `User=hive` and points to a binary inside any of these paths
 * fails to execve with `Permission denied` even when the binary itself
 * has +x — the failure is at the directory-traversal step.
 */
const NON_SYSTEM_ACCESSIBLE_PATH_PATTERNS: readonly RegExp[] = [
  /^\/root\//, // root's home (mode 0700)
  /\/\.nvm\//, // nvm-managed Node installs
  /\/\.npm\//, // npm cache directories
  /\/\.volta\//, // Volta-managed Node installs
  /\/\.fnm\//, // fnm-managed Node installs
  /\/\.asdf\//, // asdf-managed Node installs
  /\/\.local\//, // user-local installs
];

/**
 * Where to copy the binary when the source path is not system-accessible.
 * `/usr/local/bin` is on every Linux distro's default PATH and traversable
 * by any user.
 */
const SYSTEM_BINARY_TARGET = '/usr/local/bin/hivectl';

/**
 * Returns true if `binaryPath` is reachable from a non-root system user
 * (`hive`). System paths like `/usr/local/bin`, `/usr/bin`, `/opt/...` are
 * traversable; user-scoped paths under `/root/` or any `~/.*` dotdir are
 * not.
 */
export function isSystemAccessiblePath(binaryPath: string): boolean {
  return !NON_SYSTEM_ACCESSIBLE_PATH_PATTERNS.some((re) => re.test(binaryPath));
}

/**
 * Resolves a system-accessible ExecStart path for the systemd unit.
 *
 * If `sourcePath` is already system-accessible, returns it unchanged. If
 * not, copies the binary to `targetPath` (mode 0755) and returns
 * `targetPath`. Idempotent: if `targetPath` already exists with the same
 * size as `sourcePath`, the copy is skipped (operator-driven re-installs
 * after a Hive upgrade re-trigger the copy because the size changes with
 * the binary).
 *
 * Exported for unit testing.
 */
export function resolveSystemAccessibleExecPath(
  sourcePath: string,
  targetPath: string,
  stderr: NodeJS.WritableStream,
): string {
  if (isSystemAccessiblePath(sourcePath)) {
    return sourcePath;
  }
  if (existsSync(targetPath)) {
    try {
      const srcStat = statSync(sourcePath);
      const tgtStat = statSync(targetPath);
      if (srcStat.size === tgtStat.size) {
        stderr.write(
          `info: ${targetPath} already present with matching size; reusing for ExecStart\n`,
        );
        return targetPath;
      }
    } catch {
      // Stat failure → fall through to copy.
    }
  }
  mkdirSync(path.dirname(targetPath), { recursive: true });
  copyFileSync(sourcePath, targetPath);
  chmodSync(targetPath, 0o755);
  stderr.write(
    `info: copied binary from ${sourcePath} to ${targetPath} ` +
      `(source path is not traversable by the service user)\n`,
  );
  return targetPath;
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

  return { unitPath, workingDir, user, supervisor: 'launchd', execPath: deps.execPath };
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
  if (result.execPath !== undefined) {
    lines.push(`  ExecStart:   ${result.execPath}`);
  }
  if (result.execPathCopiedFrom !== undefined && result.execPath !== undefined) {
    lines.push('');
    lines.push(`  note: copied binary from ${result.execPathCopiedFrom}`);
    lines.push(`        to ${result.execPath} so the service user can traverse to it.`);
    lines.push('        (the source path is not system-accessible to non-root users.)');
  }
  // State bootstrap instructions for systemd installs. The service runs as
  // a non-root user with WorkingDirectory != the operator's cwd, so any
  // signing keys + DB created by `hivectl init` from the operator's cwd
  // will not be where `serve` looks. Make the next step explicit.
  if (result.supervisor === 'systemd') {
    lines.push('');
    lines.push('Next: bootstrap state in the working directory.');
    lines.push(`  If you have NOT yet run 'hivectl init', do it as the service user`);
    lines.push(`  inside ${result.workingDir}:`);
    lines.push('');
    lines.push(`    sudo -u ${result.user} bash -c 'cd ${result.workingDir} && hivectl init \\`);
    lines.push("       --admin-email <you@example.com> --hive-name '<your-hive>'");
    lines.push('');
    lines.push(
      `  If you ALREADY ran 'hivectl init' from another directory, copy the state into ${result.workingDir}:`,
    );
    lines.push('');
    lines.push(`    sudo cp -r <init-cwd>/var/keys ${result.workingDir}/var/keys`);
    lines.push(`    sudo cp -r <init-cwd>/var/db   ${result.workingDir}/var/db`);
    lines.push(`    sudo chown -R ${result.user}:${result.user} ${result.workingDir}/var`);
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
