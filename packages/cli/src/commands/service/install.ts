// `hivectl service install` — writes the systemd unit (Linux) or launchd
// plist (Mac) pointing at `process.execPath`. Closes INC-2026-001 FLAG-002:
// Linux installs run the server under a dedicated `hive` system user.
//
// Per the hivectl + Admin Operations tech spec § "service install".

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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

  const linuxStub = {
    platform: 'linux' as const,
    homedir: () => '/root',
    env: process.env,
    cwd: () => process.cwd(),
  };
  const user = input.user ?? getDefaultUser(linuxStub);
  const workingDir = input.workingDir ?? deps.paths?.workingDir ?? getDefaultWorkingDir(linuxStub);
  const unitPath = deps.paths?.unitPath ?? getDefaultUnitPath(linuxStub);

  ensureSystemUser(user, workingDir, deps.runner, deps.stderr);
  ensureWorkingDir(workingDir, user, deps.runner);

  // Resolve a system-accessible ExecStart path. The unit file declares
  // `User=<user>`; when the binary lives under `/root/`, `~/.nvm/`, or any
  // user dotdir, the non-root system user cannot traverse to it (mode
  // 0700) and systemd fails with `203/EXEC Permission denied`. The
  // resolution copies the **whole platform package** (binary + native/ +
  // node_modules/ + package.json) to `/usr/local/lib/hivemine-hivectl/`
  // so the SEA's createRequire chain can still resolve the bundled
  // `better-sqlite3` + transitive runtime deps. A `/usr/local/bin/hivectl`
  // symlink points at the relocated binary so the operator's PATH still
  // works. PRY-070 fixes the regression introduced by PRY-068 where the
  // binary alone was copied (breaking bundled deps resolution).
  const resolvedExecPath = resolveSystemAccessibleExecPath(
    deps.execPath,
    SYSTEM_PACKAGE_TARGET,
    SYSTEM_BIN_SYMLINK,
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
 * Where to relocate the platform package when the source path is not
 * system-accessible. The whole package directory is copied here (not just
 * the binary): the SEA's `createRequire(__filename)` chain looks for
 * bundled deps (`better-sqlite3`, `bindings`, `file-uri-to-path`)
 * starting at `<binary>/../../node_modules/`, so copying only the binary
 * leaves it unable to resolve `require('better-sqlite3')` and the
 * service crashes at first DB-touching command. Empirically reproduced
 * locally (PRY-070): `cp <bin> /tmp/x && /tmp/x --version` fails with
 * "Cannot find module 'better-sqlite3'"; `cp -r <pkg> /tmp/x && /tmp/x/
 * bin/hivectl --version` works.
 *
 * `/usr/local/lib/<pkg>/` is the FHS-compliant system location for
 * "third-party software not part of the OS". `/usr/local/bin/hivectl`
 * is created as a relative symlink to `<pkg>/bin/hivectl` so the
 * operator's PATH still picks it up, but `ExecStart` points at the real
 * path inside the package (so the SEA's `__filename` resolves there
 * and the createRequire chain finds the bundled deps).
 */
const SYSTEM_PACKAGE_TARGET = '/usr/local/lib/hivemine-hivectl';
const SYSTEM_BIN_SYMLINK = '/usr/local/bin/hivectl';

/**
 * Returns true if `binaryPath` is reachable from a non-root system user.
 * System paths like `/usr/local/lib`, `/usr/bin`, `/opt/...` are
 * traversable; user-scoped paths under `/root/` or any `~/.*` dotdir are
 * not.
 */
export function isSystemAccessiblePath(binaryPath: string): boolean {
  return !NON_SYSTEM_ACCESSIBLE_PATH_PATTERNS.some((re) => re.test(binaryPath));
}

/**
 * Walks up from a binary path to locate the platform package root (the
 * directory containing `package.json`). For our shipped layout:
 *   <pkg-root>/bin/hivectl                ← binary
 *   <pkg-root>/native/better_sqlite3.node ← bundled binding (PRY-067)
 *   <pkg-root>/node_modules/...           ← bundled runtime deps (PRY-066)
 *   <pkg-root>/package.json
 *
 * Returns the package root path (two levels up from the binary file).
 * Throws if no `package.json` is found within the parent chain — that
 * means the binary is being run outside the npm-installed layout (e.g.
 * a dev SEA build), and we cannot relocate it without breaking the
 * createRequire chain.
 *
 * Exported for unit testing.
 */
export function findPlatformPackageRoot(binaryPath: string): string {
  // <pkg>/bin/hivectl → <pkg> is two `dirname`s up.
  const candidate = path.dirname(path.dirname(binaryPath));
  if (existsSync(path.join(candidate, 'package.json'))) {
    return candidate;
  }
  throw new Error(
    `Cannot locate platform package root for binary at ${binaryPath}: ` +
      `no package.json at expected location ${candidate}. ` +
      `The binary must be installed under a node package layout ` +
      `(<pkg-root>/bin/hivectl + <pkg-root>/package.json).`,
  );
}

/**
 * Resolves a system-accessible ExecStart path for the systemd unit.
 *
 * If `sourceBinaryPath` is already system-accessible, returns it
 * unchanged. If not, **copies the entire platform package directory**
 * (binary + native/ + node_modules/ + package.json) to
 * `targetPackageRoot`, creates a `bin/hivectl` symlink at
 * `targetBinSymlink` so the operator's PATH picks up the relocated
 * install, and returns the path inside the relocated package
 * (`targetPackageRoot/bin/hivectl`). The unit's `ExecStart` uses that
 * path so the SEA's `createRequire(__filename)` chain walks
 * `targetPackageRoot/bin/.. -> targetPackageRoot/node_modules/...` and
 * finds the bundled `better-sqlite3` + `bindings` + `file-uri-to-path`.
 *
 * Idempotent: if `targetPackageRoot/bin/hivectl` already exists with
 * the same size as `sourceBinaryPath`, the copy is skipped. A Hive
 * upgrade changes the binary size and re-triggers a fresh recursive
 * copy (the previous copy is removed first to avoid stale files
 * surviving the upgrade).
 *
 * Exported for unit testing.
 */
export function resolveSystemAccessibleExecPath(
  sourceBinaryPath: string,
  targetPackageRoot: string,
  targetBinSymlink: string,
  stderr: NodeJS.WritableStream,
): string {
  if (isSystemAccessiblePath(sourceBinaryPath)) {
    return sourceBinaryPath;
  }
  const sourcePackageRoot = findPlatformPackageRoot(sourceBinaryPath);
  const sourceBinaryName = path.basename(sourceBinaryPath);
  const targetBinaryPath = path.join(targetPackageRoot, 'bin', sourceBinaryName);
  // Idempotent skip — same-size binary at the target means we already
  // copied this version. Avoids a 100+MB recursive copy on every
  // re-run of `service install`.
  if (existsSync(targetBinaryPath)) {
    try {
      const srcStat = statSync(sourceBinaryPath);
      const tgtStat = statSync(targetBinaryPath);
      if (srcStat.size === tgtStat.size) {
        stderr.write(
          `info: ${targetPackageRoot} already present with matching binary size; reusing for ExecStart\n`,
        );
        ensureBinSymlink(targetBinaryPath, targetBinSymlink);
        return targetBinaryPath;
      }
    } catch {
      // Stat failure → fall through to copy.
    }
    // Different size → upgrade scenario; remove stale before copy.
    rmSync(targetPackageRoot, { recursive: true, force: true });
  }
  mkdirSync(path.dirname(targetPackageRoot), { recursive: true });
  cpSync(sourcePackageRoot, targetPackageRoot, { recursive: true });
  chmodSync(targetBinaryPath, 0o755);
  ensureBinSymlink(targetBinaryPath, targetBinSymlink);
  stderr.write(
    `info: copied platform package from ${sourcePackageRoot} to ${targetPackageRoot} ` +
      `(source path is not traversable by the service user; ` +
      `the bundled better-sqlite3 + transitive runtime deps must travel ` +
      `with the binary so the SEA's createRequire chain can resolve them)\n`,
  );
  stderr.write(`info: created bin symlink ${targetBinSymlink} -> ${targetBinaryPath}\n`);
  return targetBinaryPath;
}

/**
 * Creates or updates the bin symlink so `hivectl` on the operator's PATH
 * points at the relocated binary inside the platform package. Removes
 * any existing file at the symlink path first (could be a stale copy
 * from an older install).
 */
function ensureBinSymlink(targetBinary: string, symlinkPath: string): void {
  // `node:fs.symlinkSync` doesn't expose a `force` option in stable
  // Node, so we remove first. The symlink is in `/usr/local/bin/`
  // which the install step already requires root on, so the unlink
  // is allowed.
  if (existsSync(symlinkPath)) {
    rmSync(symlinkPath, { force: true });
  }
  mkdirSync(path.dirname(symlinkPath), { recursive: true });
  // Use a relative target so the symlink is portable across copy
  // operations. `/usr/local/bin/hivectl -> ../lib/hivemine-hivectl/bin/hivectl`.
  const relativeTarget = path.relative(path.dirname(symlinkPath), targetBinary);
  symlinkSync(relativeTarget, symlinkPath);
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
    cwd: () => process.cwd(),
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
  // State check for systemd installs. With the PRY-069 default
  // (WorkingDirectory = process.cwd(), User = invoking user), the operator
  // is typically already in a directory where they ran `hivectl init`.
  // If yes — nothing to do, `start` will read the existing state.
  // If no — single-line hint to run init in the working dir.
  if (result.supervisor === 'systemd') {
    const stateOk = existsSync(path.join(result.workingDir, 'var', 'keys'));
    lines.push('');
    if (stateOk) {
      lines.push(`State:       found at ${path.join(result.workingDir, 'var', 'keys')}`);
    } else {
      lines.push(`State:       not yet initialized in ${result.workingDir}/var/`);
      lines.push(`             Run 'hivectl init --admin-email <X> --hive-name <Y>' in this`);
      lines.push(`             directory before starting the service.`);
    }
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
