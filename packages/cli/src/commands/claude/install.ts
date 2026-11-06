// `hivectl claude install --server <url> --enrollment-credential <file> [--project <path>]`
// and `hivectl claude uninstall [--project <path>] --yes` (ADR-026 decision 3.d).
// Local clients: no database, no runtime. The enrollment credential is a file
// (0600) and only ever lands in ~/.config/hive/, never inside the project.

import { execFile } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import { CliError } from '#error/cli-error.js';
import {
  configRoot,
  projectKey,
  removePrivateFile,
  statePaths,
  writePrivateJson,
} from '#session/state-dir.js';
import type { DiscoverOutcome } from '#session/upstream.js';

import {
  findOnPath,
  isOlderThanValidated,
  runClaude,
  VALIDATED_CLAUDE_VERSION,
} from './claude-cli.js';
import { installPluginCopy, marketplaceDir, MARKETPLACE_NAME, PLUGIN_NAME } from './plugin.js';
import type { HivectlCommand } from './plugin.js';

const SETTINGS_LOCAL = '.claude/settings.local.json';
const GROUP_OR_OTHER = 0o077;

export interface ClaudeCommandDeps {
  env: NodeJS.ProcessEnv;
  home: string;
  cwd: string;
  platform?: NodeJS.Platform;
  warn(message: string): void;
  pluginSource(): string | undefined;
  hivectl: HivectlCommand;
  discover(url: string, credential: string): Promise<DiscoverOutcome>;
  now(): Date;
}

export interface ClaudeInstallOpts {
  server: string | undefined;
  enrollmentCredential: string | undefined;
  project: string | undefined;
}

export interface ClaudeInstallResult {
  project: string;
  serverUrl: string;
  enrollmentFile: string;
  marketplace: string;
  settingsFile: string;
  gitignore: 'added' | 'already_ignored' | 'not_a_git_repository';
  warnings: string[];
}

function resolveProject(raw: string | undefined, cwd: string): string {
  const path = resolve(cwd, raw ?? '.');
  try {
    if (!statSync(path).isDirectory()) throw new Error('not a directory');
    return realpathSync(path);
  } catch {
    throw new CliError('INVALID_INPUT', {
      subCode: 'project_not_found',
      message: `${path} is not a folder`,
    });
  }
}

function parseServerUrl(raw: string | undefined): string {
  if (raw === undefined || raw === '') {
    throw new CliError('INVALID_INPUT', {
      subCode: 'server_required',
      message: '--server <url> is required',
    });
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError('INVALID_INPUT', {
      subCode: 'server_url_invalid',
      message: `'${raw}' is not a URL`,
    });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CliError('INVALID_INPUT', {
      subCode: 'server_url_invalid',
      message: `'${raw}' must be an http or https URL`,
    });
  }
  return url.toString();
}

/** Reads the credential file (0600 or stricter) and checks `scope = enroll` without verifying the signature. */
function readEnrollmentCredential(path: string | undefined, platform: NodeJS.Platform): string {
  if (path === undefined || path === '') {
    throw new CliError('INVALID_INPUT', {
      subCode: 'enrollment_credential_required',
      message: '--enrollment-credential <file> is required',
    });
  }
  let mode: number;
  let text: string;
  try {
    mode = statSync(path).mode;
    text = readFileSync(path, 'utf8').trim();
  } catch {
    throw new CliError('INVALID_INPUT', {
      subCode: 'credential_file_unreadable',
      message: `cannot read the credential file ${path}`,
    });
  }
  if (platform !== 'win32' && (mode & GROUP_OR_OTHER) !== 0) {
    throw new CliError('SESSION_STATE_INSECURE_PERMS', {
      message: `${path} must be readable by its owner only (chmod 600)`,
    });
  }
  let scope: unknown;
  try {
    const payload = text.split('.')[1] ?? '';
    scope = (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { scope?: unknown })
      .scope;
  } catch {
    scope = undefined;
  }
  if (scope !== 'enroll') {
    throw new CliError('NOT_AN_ENROLLMENT_CREDENTIAL', {
      message: `${path} does not hold an enrollment credential (scope enroll); issue one with \`hivectl credential issue --enrollment\``,
    });
  }
  return text;
}

function requireClaude(env: NodeJS.ProcessEnv): string {
  const claude = findOnPath('claude', env['PATH']);
  if (claude === undefined) {
    throw new CliError('CLAUDE_CLI_NOT_FOUND', {
      message: 'install Claude Code and make sure `claude` is on the PATH',
    });
  }
  return claude;
}

function git(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((done) => {
    execFile('git', args, { cwd, env }, (err) => {
      done(err === null ? 0 : typeof err.code === 'number' ? err.code : 128);
    });
  });
}

async function ensureGitignored(
  project: string,
  env: NodeJS.ProcessEnv,
): Promise<ClaudeInstallResult['gitignore']> {
  if ((await git(['rev-parse', '--is-inside-work-tree'], project, env)) !== 0) {
    return 'not_a_git_repository';
  }
  if ((await git(['check-ignore', '-q', SETTINGS_LOCAL], project, env)) === 0)
    return 'already_ignored';
  const file = join(project, '.gitignore');
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const lines = current.split(/\r?\n/);
  if (!lines.includes(SETTINGS_LOCAL) && !lines.includes(`/${SETTINGS_LOCAL}`)) {
    const separator = current === '' || current.endsWith('\n') ? '' : '\n';
    appendFileSync(file, `${separator}${SETTINGS_LOCAL}\n`);
  }
  return 'added';
}

const SYNCED_FOLDER = /\/(Library\/Mobile Documents|iCloud[^/]*|Dropbox[^/]*|OneDrive[^/]*)(\/|$)/i;

function looksSynchronized(project: string): boolean {
  return SYNCED_FOLDER.test(project) || existsSync(join(project, '.obsidian'));
}

const ALREADY = /already/i;

async function claudeStep(
  claude: string,
  args: string[],
  project: string,
  env: NodeJS.ProcessEnv,
  tolerated: RegExp,
): Promise<string | undefined> {
  const run = await runClaude(claude, args, project, env);
  if (run.code === 0 || tolerated.test(`${run.stdout}\n${run.stderr}`)) return undefined;
  const detail = (run.stderr.trim() || run.stdout.trim() || `exit code ${String(run.code)}`).slice(
    0,
    2000,
  );
  return `claude ${args.join(' ')}: ${detail}`;
}

export async function runClaudeInstall(
  opts: ClaudeInstallOpts,
  deps: ClaudeCommandDeps,
): Promise<ClaudeInstallResult> {
  const platform = deps.platform ?? process.platform;
  const serverUrl = parseServerUrl(opts.server);
  const project = resolveProject(opts.project, deps.cwd);
  const claude = requireClaude(deps.env);
  const credential = readEnrollmentCredential(opts.enrollmentCredential, platform);
  const warnings: string[] = [];
  const warn = (message: string): void => {
    warnings.push(message);
    deps.warn(message);
  };

  const source = deps.pluginSource();
  if (source === undefined) {
    throw new CliError('CLAUDE_PLUGIN_COMMAND_FAILED', {
      subCode: 'plugin_source_not_found',
      message: 'the hive-wake plugin is not next to this hivectl; reinstall @hivemine/hivectl',
    });
  }
  const version = await runClaude(claude, ['--version'], project, deps.env);
  const older = isOlderThanValidated(version.stdout);
  if (older !== false) {
    warn(
      `Claude Code ${version.stdout.trim() || '(unknown version)'} is older than the validated ${VALIDATED_CLAUDE_VERSION.join('.')} (or unknown)`,
    );
  }
  const discovered = await deps.discover(serverUrl, credential);
  if (!discovered.ok)
    warn(`could not check the Hive server at ${serverUrl}: ${discovered.message}`);

  const root = configRoot(deps.env, deps.home);
  const paths = statePaths(root);
  const key = projectKey(project);
  const enrollmentFile = paths.enrollment(key);
  writePrivateJson(enrollmentFile, {
    projectPath: project,
    serverUrl,
    credential,
    hivectlPath: deps.hivectl.args[0] ?? deps.hivectl.command,
    installedAt: deps.now().toISOString(),
  });

  const marketplace = installPluginCopy(source, root, deps.hivectl);

  for (const args of [
    ['plugin', 'marketplace', 'add', marketplace, '--scope', 'local'],
    ['plugin', 'install', `${PLUGIN_NAME}@${MARKETPLACE_NAME}`, '--scope', 'local', '-y'],
  ]) {
    const failure = await claudeStep(claude, args, project, deps.env, ALREADY);
    if (failure !== undefined) {
      throw new CliError('CLAUDE_PLUGIN_COMMAND_FAILED', {
        message: `${failure} (the enrollment and the plugin copy were saved; run install again)`,
      });
    }
  }

  const gitignore = await ensureGitignored(project, deps.env);
  if (looksSynchronized(project)) {
    warn(
      `${join(project, SETTINGS_LOCAL)} will be visible in this synchronized folder (it holds no secret)`,
    );
  }

  return {
    project,
    serverUrl,
    enrollmentFile,
    marketplace,
    settingsFile: join(project, SETTINGS_LOCAL),
    gitignore,
    warnings,
  };
}

export interface ClaudeUninstallOpts {
  project: string | undefined;
  yes: boolean;
}

export interface ClaudeUninstallResult {
  project: string;
  removed: string[];
  pluginCopyRemoved: boolean;
}

/** Only the answers that mean "already removed"; anything else is a real failure. */
const NOT_PRESENT = /not installed|not found|no such|no marketplace/i;

export async function runClaudeUninstall(
  opts: ClaudeUninstallOpts,
  deps: Omit<ClaudeCommandDeps, 'pluginSource' | 'hivectl' | 'discover'>,
): Promise<ClaudeUninstallResult> {
  if (!opts.yes) {
    throw new CliError('CONFIRMATION_DECLINED', {
      subCode: 'requires_yes',
      message: 'claude uninstall removes the Hive enrollment of this folder; pass --yes to confirm',
    });
  }
  const project = resolveProject(opts.project, deps.cwd);
  const claude = findOnPath('claude', deps.env['PATH']);
  const failures: string[] = [];
  if (claude !== undefined) {
    for (const args of [
      ['plugin', 'uninstall', `${PLUGIN_NAME}@${MARKETPLACE_NAME}`, '--scope', 'local'],
      ['plugin', 'marketplace', 'remove', MARKETPLACE_NAME, '--scope', 'local'],
    ]) {
      const failure = await claudeStep(claude, args, project, deps.env, NOT_PRESENT);
      if (failure !== undefined) failures.push(failure);
    }
  }

  const root = configRoot(deps.env, deps.home);
  const paths = statePaths(root);
  const key = projectKey(project);
  const removed: string[] = [];
  removePrivateFile(paths.enrollment(key));
  removed.push(paths.enrollment(key));
  for (const dir of [paths.sessionsDir(key), paths.tokensDir(key)]) {
    rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  let remaining: string[] = [];
  try {
    remaining = readdirSync(paths.enrollmentDir).filter((f) => f.endsWith('.json'));
  } catch {
    remaining = [];
  }
  const pluginCopyRemoved = remaining.length === 0;
  if (pluginCopyRemoved) rmSync(marketplaceDir(root), { recursive: true, force: true });

  if (claude === undefined) {
    throw new CliError('CLAUDE_CLI_NOT_FOUND', {
      message:
        'the local Hive state was removed, but `claude` is not on the PATH to remove the plugin',
    });
  }
  if (failures.length > 0) {
    throw new CliError('CLAUDE_PLUGIN_COMMAND_FAILED', {
      message: `${failures.join('; ')} (the local Hive state was removed)`,
    });
  }
  return { project, removed, pluginCopyRemoved };
}
