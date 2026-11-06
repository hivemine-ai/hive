// `claude install` / `uninstall` against a fake `claude` on the PATH that records
// its argv and working directory, a temporary HOME and HIVE_CONFIG_DIR, and a real
// git repository as the project. The user's real Claude Code config is never touched.

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CliError } from '#error/cli-error.js';
import { mapErrorToExit } from '#error/handler.js';
import { projectKey, statePaths } from '#session/state-dir.js';

import { runClaudeInstall, runClaudeUninstall } from './install.js';
import type { ClaudeCommandDeps } from './install.js';
import { currentHivectlCommand, findPluginSource } from './plugin.js';

const PLUGIN_SOURCE = fileURLToPath(new URL('../../../../claude-plugin', import.meta.url));
const SERVER = 'https://hive.example.com/mcp';

let dir: string;
let home: string;
let config: string;
let project: string;
let bin: string;
let claudeLog: string;
let warnings: string[];

function jwt(payload: Record<string, unknown>): string {
  const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${part({ alg: 'EdDSA' })}.${part(payload)}.c2ln`;
}

function credentialFile(
  payload: Record<string, unknown> = { scope: 'enroll', sub: 'x' },
  mode = 0o600,
): string {
  const path = join(dir, `cred-${String(Math.random()).slice(2)}.jwt`);
  writeFileSync(path, `${jwt(payload)}\n`, { mode });
  chmodSync(path, mode);
  return path;
}

/** A fake claude: logs "<cwd>|<args>" and answers per FAKE_CLAUDE_* variables. */
function writeFakeClaude(): void {
  mkdirSync(bin, { recursive: true });
  const script = `#!/bin/sh
echo "$PWD|$*" >> "${claudeLog}"
if [ "$1" = "--version" ]; then echo "\${FAKE_CLAUDE_VERSION:-2.1.318} (Claude Code)"; exit 0; fi
if [ -n "$FAKE_CLAUDE_FAIL_ON" ] && echo "$*" | grep -q -- "$FAKE_CLAUDE_FAIL_ON"; then
  echo "\${FAKE_CLAUDE_FAIL_TEXT:-boom}" >&2; exit 1
fi
echo "ok"
`;
  writeFileSync(join(bin, 'claude'), script, { mode: 0o755 });
}

function deps(env: Record<string, string> = {}): ClaudeCommandDeps {
  return {
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HIVE_CONFIG_DIR: config,
      HOME: home,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      ...env,
    },
    home,
    cwd: project,
    warn: (m) => warnings.push(m),
    pluginSource: () => PLUGIN_SOURCE,
    hivectl: { command: '/opt/hive/bin/hivectl', args: [] },
    discover: () => Promise.resolve({ ok: true }),
    now: () => new Date('2026-11-06T10:00:00Z'),
  };
}

function claudeCalls(): { cwd: string; args: string }[] {
  if (!existsSync(claudeLog)) return [];
  return readFileSync(claudeLog, 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      const [cwd = '', args = ''] = line.split('|');
      return { cwd, args };
    })
    .filter((c) => c.args !== '--version');
}

function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const full = join(root, name);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full));
    else out.push(full);
  }
  return out;
}

async function caught(promise: Promise<unknown>): Promise<CliError> {
  try {
    await promise;
  } catch (err) {
    return err as CliError;
  }
  throw new Error('expected a failure');
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'hive-claude-')));
  chmodSync(dir, 0o700);
  home = join(dir, 'home');
  config = join(dir, 'config');
  project = join(dir, 'vault');
  bin = join(dir, 'bin');
  claudeLog = join(dir, 'claude.log');
  mkdirSync(home);
  mkdirSync(project);
  execFileSync('git', ['init', '-q'], { cwd: project });
  writeFakeClaude();
  warnings = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('hivectl claude install', () => {
  it('saves the credential only under the config dir, installs the plugin with --scope local and ignores settings.local.json', async () => {
    const cred = credentialFile();

    const result = await runClaudeInstall(
      { server: SERVER, enrollmentCredential: cred, project: undefined },
      deps(),
    );

    const enrollment = statePaths(config).enrollment(projectKey(project));
    expect(result.enrollmentFile).toBe(enrollment);
    expect(statSync(enrollment).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(readFileSync(enrollment, 'utf8')) as Record<string, unknown>;
    expect(saved).toMatchObject({
      projectPath: project,
      serverUrl: SERVER,
      hivectlPath: '/opt/hive/bin/hivectl',
    });
    expect(saved['credential']).toBe(readFileSync(cred, 'utf8').trim());

    const secret = readFileSync(cred, 'utf8').trim();
    for (const file of filesUnder(project).filter((f) => !f.includes('/.git/'))) {
      expect(readFileSync(file, 'utf8')).not.toContain(secret);
    }

    expect(claudeCalls()).toEqual([
      { cwd: project, args: `plugin marketplace add ${join(config, 'marketplace')} --scope local` },
      { cwd: project, args: 'plugin install hive-wake@hive --scope local -y' },
    ]);
    const marketplace = JSON.parse(
      readFileSync(join(config, 'marketplace', '.claude-plugin', 'marketplace.json'), 'utf8'),
    ) as { name: string; plugins: { name: string; source: string }[] };
    expect(marketplace.name).toBe('hive');
    expect(marketplace.plugins).toEqual([
      expect.objectContaining({ name: 'hive-wake', source: './plugins/hive-wake' }),
    ]);
    const manifest = JSON.parse(
      readFileSync(
        join(config, 'marketplace', 'plugins', 'hive-wake', '.claude-plugin', 'plugin.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    expect(manifest['name']).toBe('hive-wake');
    expect(manifest['userConfig']).toBeUndefined();
    expect(manifest['mcpServers']).toEqual({
      hive: { command: '/opt/hive/bin/hivectl', args: ['mcp', 'proxy'] },
    });
    expect(JSON.stringify(manifest)).not.toContain(secret);

    expect(result.gitignore).toBe('added');
    expect(readFileSync(join(project, '.gitignore'), 'utf8')).toBe('.claude/settings.local.json\n');
    expect(warnings).toEqual([]);
  });

  it('is idempotent: refreshes the credential, tolerates "already installed" and never duplicates the .gitignore line', async () => {
    await runClaudeInstall(
      { server: SERVER, enrollmentCredential: credentialFile(), project: undefined },
      deps(),
    );
    const rotated = credentialFile({ scope: 'enroll', sub: 'rotated' });

    const second = await runClaudeInstall(
      { server: SERVER, enrollmentCredential: rotated, project: undefined },
      deps({ FAKE_CLAUDE_FAIL_ON: 'plugin', FAKE_CLAUDE_FAIL_TEXT: 'Plugin already installed' }),
    );

    expect(second.gitignore).toBe('already_ignored');
    expect(readFileSync(join(project, '.gitignore'), 'utf8')).toBe('.claude/settings.local.json\n');
    const saved = JSON.parse(
      readFileSync(statePaths(config).enrollment(projectKey(project)), 'utf8'),
    ) as { credential: string };
    expect(saved.credential).toBe(readFileSync(rotated, 'utf8').trim());
  });

  it('appends to an existing .gitignore without a trailing newline', async () => {
    writeFileSync(join(project, '.gitignore'), 'node_modules');
    await runClaudeInstall(
      { server: SERVER, enrollmentCredential: credentialFile(), project: undefined },
      deps(),
    );
    expect(readFileSync(join(project, '.gitignore'), 'utf8')).toBe(
      'node_modules\n.claude/settings.local.json\n',
    );
  });

  it('fails with CLAUDE_CLI_NOT_FOUND (exit 4) when claude is not on the PATH', async () => {
    const err = await caught(
      runClaudeInstall(
        { server: SERVER, enrollmentCredential: credentialFile(), project: undefined },
        deps({ PATH: '/usr/bin:/bin' }),
      ),
    );
    expect(err.code).toBe('CLAUDE_CLI_NOT_FOUND');
    expect(mapErrorToExit(err).code).toBe(4);
  });

  it('fails with NOT_AN_ENROLLMENT_CREDENTIAL (exit 1) for a credential without scope enroll', async () => {
    for (const payload of [{ sub: 'worker' }, { scope: 'admin' }]) {
      const err = await caught(
        runClaudeInstall(
          { server: SERVER, enrollmentCredential: credentialFile(payload), project: undefined },
          deps(),
        ),
      );
      expect(err.code).toBe('NOT_AN_ENROLLMENT_CREDENTIAL');
      expect(mapErrorToExit(err).code).toBe(1);
    }
    expect(existsSync(config)).toBe(false);
  });

  it('fails with SESSION_STATE_INSECURE_PERMS for a credential file laxer than 0600', async () => {
    const err = await caught(
      runClaudeInstall(
        {
          server: SERVER,
          enrollmentCredential: credentialFile(undefined, 0o644),
          project: undefined,
        },
        deps(),
      ),
    );
    expect(err.code).toBe('SESSION_STATE_INSECURE_PERMS');
    expect(mapErrorToExit(err).code).toBe(4);
  });

  it('rejects a server that is not an http(s) URL with INVALID_INPUT', async () => {
    const err = await caught(
      runClaudeInstall(
        { server: 'ftp://x', enrollmentCredential: credentialFile(), project: undefined },
        deps(),
      ),
    );
    expect(err.code).toBe('INVALID_INPUT');
  });

  it('reports a failing claude command as CLAUDE_PLUGIN_COMMAND_FAILED with its stderr and keeps what it saved', async () => {
    const err = await caught(
      runClaudeInstall(
        { server: SERVER, enrollmentCredential: credentialFile(), project: undefined },
        deps({
          FAKE_CLAUDE_FAIL_ON: 'plugin install',
          FAKE_CLAUDE_FAIL_TEXT: 'marketplace hive is broken',
        }),
      ),
    );
    expect(err.code).toBe('CLAUDE_PLUGIN_COMMAND_FAILED');
    expect(err.message).toContain('marketplace hive is broken');
    expect(existsSync(statePaths(config).enrollment(projectKey(project)))).toBe(true);
  });

  it('warns, without failing, on an older Claude Code, an unreachable Hive and a synchronized vault', async () => {
    mkdirSync(join(project, '.obsidian'));
    const result = await runClaudeInstall(
      { server: SERVER, enrollmentCredential: credentialFile(), project: undefined },
      {
        ...deps({ FAKE_CLAUDE_VERSION: '2.1.200' }),
        discover: () => Promise.resolve({ ok: false, code: 'transport', message: 'fetch failed' }),
      },
    );
    expect(result.warnings).toHaveLength(3);
    expect(warnings.join('\n')).toMatch(/older than the validated 2\.1\.318/);
    expect(warnings.join('\n')).toMatch(/could not check the Hive server/);
    expect(warnings.join('\n')).toMatch(/synchronized folder/);
  });

  it('without the plugin next to hivectl fails before saving anything (no partial state)', async () => {
    const err = await caught(
      runClaudeInstall(
        { server: SERVER, enrollmentCredential: credentialFile(), project: undefined },
        { ...deps(), pluginSource: () => undefined },
      ),
    );
    expect(err.code).toBe('CLAUDE_PLUGIN_COMMAND_FAILED');
    expect(existsSync(config)).toBe(false);
    expect(claudeCalls()).toEqual([]);
  });

  it('outside a git repository leaves no .gitignore', async () => {
    const plain = join(dir, 'plain');
    mkdirSync(plain);
    const result = await runClaudeInstall(
      { server: SERVER, enrollmentCredential: credentialFile(), project: plain },
      deps(),
    );
    expect(result.gitignore).toBe('not_a_git_repository');
    expect(existsSync(join(plain, '.gitignore'))).toBe(false);
  });
});

describe('hivectl claude uninstall', () => {
  it('removes the plugin, the enrollment and the session state of the folder, and the plugin copy once unused', async () => {
    await runClaudeInstall(
      { server: SERVER, enrollmentCredential: credentialFile(), project: undefined },
      deps(),
    );
    const key = projectKey(project);
    const paths = statePaths(config);
    mkdirSync(paths.tokensDir(key), { recursive: true, mode: 0o700 });
    writeFileSync(join(paths.tokensDir(key), 'claude-api.json'), '{}', { mode: 0o600 });
    mkdirSync(paths.sessionsDir(key), { recursive: true, mode: 0o700 });
    writeFileSync(join(paths.sessionsDir(key), 's1.json'), '{}', { mode: 0o600 });

    mkdirSync(join(project, '.claude'));
    writeFileSync(join(project, '.claude', 'settings.local.json'), '{"enabledPlugins":{}}');

    const result = await runClaudeUninstall({ project: undefined, yes: true }, deps());

    expect(readFileSync(join(project, '.gitignore'), 'utf8')).toBe('.claude/settings.local.json\n');
    expect(existsSync(join(project, '.claude', 'settings.local.json'))).toBe(true);
    expect(claudeCalls().slice(-2)).toEqual([
      { cwd: project, args: 'plugin uninstall hive-wake@hive --scope local' },
      { cwd: project, args: 'plugin marketplace remove hive --scope local' },
    ]);
    expect(result.pluginCopyRemoved).toBe(true);
    expect(filesUnder(config).filter((f) => f.includes(key))).toEqual([]);
    expect(existsSync(join(config, 'marketplace'))).toBe(false);
  });

  it('keeps the plugin copy while another folder still uses it, and tolerates steps already undone', async () => {
    const other = join(dir, 'other');
    mkdirSync(other);
    await runClaudeInstall(
      { server: SERVER, enrollmentCredential: credentialFile(), project: other },
      deps(),
    );
    await runClaudeInstall(
      { server: SERVER, enrollmentCredential: credentialFile(), project: undefined },
      deps(),
    );

    const result = await runClaudeUninstall(
      { project: undefined, yes: true },
      deps({ FAKE_CLAUDE_FAIL_ON: 'plugin', FAKE_CLAUDE_FAIL_TEXT: 'Plugin not found' }),
    );

    expect(result.pluginCopyRemoved).toBe(false);
    expect(existsSync(join(config, 'marketplace'))).toBe(true);
    expect(existsSync(statePaths(config).enrollment(projectKey(other)))).toBe(true);
  });

  it('fails when claude rejects the uninstall for another reason (an unknown option is not "already removed")', async () => {
    await runClaudeInstall(
      { server: SERVER, enrollmentCredential: credentialFile(), project: undefined },
      deps(),
    );

    const err = await caught(
      runClaudeUninstall(
        { project: undefined, yes: true },
        deps({
          FAKE_CLAUDE_FAIL_ON: 'uninstall',
          FAKE_CLAUDE_FAIL_TEXT: "error: unknown option '--scope'",
        }),
      ),
    );

    expect(err.code).toBe('CLAUDE_PLUGIN_COMMAND_FAILED');
    expect(err.message).toContain('unknown option');
  });

  it('requires --yes', async () => {
    const err = await caught(runClaudeUninstall({ project: undefined, yes: false }, deps()));
    expect(err.code).toBe('CONFIRMATION_DECLINED');
  });

  it('removes the local state and then fails with CLAUDE_PLUGIN_COMMAND_FAILED when claude fails', async () => {
    await runClaudeInstall(
      { server: SERVER, enrollmentCredential: credentialFile(), project: undefined },
      deps(),
    );

    const err = await caught(
      runClaudeUninstall(
        { project: undefined, yes: true },
        deps({ FAKE_CLAUDE_FAIL_ON: 'uninstall', FAKE_CLAUDE_FAIL_TEXT: 'settings are read-only' }),
      ),
    );

    expect(err.code).toBe('CLAUDE_PLUGIN_COMMAND_FAILED');
    expect(existsSync(statePaths(config).enrollment(projectKey(project)))).toBe(false);
  });
});

describe('plugin location and command', () => {
  it('finds the plugin in a checkout and in the npm wrapper package, nested or hoisted', () => {
    expect(findPluginSource([join(PLUGIN_SOURCE, '..', 'cli', 'dist')])).toBe(PLUGIN_SOURCE);

    const prefix = join(dir, 'npm');
    const wrapper = join(prefix, 'node_modules', '@hivemine', 'hivectl');
    mkdirSync(join(wrapper, 'claude-plugin', '.claude-plugin'), { recursive: true });
    writeFileSync(join(wrapper, 'claude-plugin', 'distribution.json'), '{"files":[]}');
    const nested = join(wrapper, 'node_modules', '@hivemine', 'hivectl-linux-x64', 'bin');
    const hoisted = join(prefix, 'node_modules', '@hivemine', 'hivectl-linux-x64', 'bin');
    expect(findPluginSource([nested])).toBe(join(wrapper, 'claude-plugin'));
    expect(findPluginSource([hoisted])).toBe(join(wrapper, 'claude-plugin'));
    expect(findPluginSource([join(dir, 'nowhere')])).toBeUndefined();
  });

  it('pins the single executable, or node plus the entry script, never a wrapper', () => {
    expect(currentHivectlCommand('/opt/bin/hivectl', '/opt/bin/hivectl', true)).toEqual({
      command: '/opt/bin/hivectl',
      args: [],
    });
    const entry = join(dir, 'main.js');
    writeFileSync(entry, '');
    expect(currentHivectlCommand('/usr/bin/node', entry, false)).toEqual({
      command: '/usr/bin/node',
      args: [entry],
    });
  });
});
