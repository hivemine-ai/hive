// The plugin's command hooks as real processes (the compiled CLI; requires
// `pnpm build`), fed the JSON Claude Code writes on stdin. The test process plays
// `claude`: it is the parent of every hook.

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { processStartTime } from '#session/pid-map.js';
import { projectKey, readPrivateJson, statePaths, writePrivateJson } from '#session/state-dir.js';
import type { StatePaths } from '#session/state-dir.js';

const CLI_ENTRY = fileURLToPath(new URL('../../../dist/main.js', import.meta.url));

let scratch: string;
let configDir: string;
let projectDir: string;
let paths: StatePaths;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'hive-hooks-proc-'));
  chmodSync(scratch, 0o700);
  configDir = join(scratch, 'config');
  projectDir = join(scratch, 'project');
  mkdirSync(projectDir);
  paths = statePaths(configDir);
  writePrivateJson(paths.enrollment(projectKey(projectDir)), {
    projectPath: projectDir,
    serverUrl: 'http://127.0.0.1:1/mcp',
    credential: 'enroll.jwt',
    hivectlPath: CLI_ENTRY,
    installedAt: new Date().toISOString(),
  });
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function hook(kind: string, stdin: string, env: NodeJS.ProcessEnv = {}) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [CLI_ENTRY, 'claude', 'hook', kind], {
    cwd: projectDir,
    input: stdin,
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: scratch,
      HIVE_CONFIG_DIR: configDir,
      CLAUDE_PROJECT_DIR: projectDir,
      ...env,
    },
  });
  return { ...result, ms: Date.now() - started };
}

const startInput = (source = 'startup', sessionId = 'f1e2d3c4-0000-4000-8000-000000000001') =>
  JSON.stringify({
    session_id: sessionId,
    transcript_path: join(scratch, 't.jsonl'),
    cwd: projectDir,
    hook_event_name: 'SessionStart',
    source,
  });

describe('claude hook (process)', () => {
  it('session-start writes the PID-map entry of its parent claude and prints the context', () => {
    const run = hook('session-start', startInput());
    expect(run.status).toBe(0);
    const out = JSON.parse(run.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(out.hookSpecificOutput.additionalContext).toContain(
      'mcp__plugin_hive-wake_hive__register_session',
    );
    expect(readPrivateJson(paths.pidMap(process.pid))).toEqual({
      claudePid: process.pid,
      claudeStartTime: processStartTime(process.pid),
      sessionId: 'f1e2d3c4-0000-4000-8000-000000000001',
      source: 'startup',
    });
    expect(run.ms).toBeLessThan(5_000);
  });

  it('a forced error never fails the start: exit 0, no context, one line on stderr', () => {
    const bad = hook('session-start', 'this is not json');
    expect(bad.status).toBe(0);
    expect(bad.stdout).toBe('');
    expect(bad.stderr).toMatch(/"event":"hook.failed"/);

    chmodSync(join(configDir, 'enrollment'), 0o755);
    const insecure = hook('session-start', startInput());
    expect(insecure.status).toBe(0);
    expect(insecure.stdout).toBe('');
    expect(insecure.stderr).toMatch(/hook.failed/);
    chmodSync(join(configDir, 'enrollment'), 0o700);

    const unknown = hook('no-such-hook', '{}');
    expect(unknown.status).toBe(0);
    expect(unknown.stdout).toBe('');
  });

  it('with the harness marker writes nothing and prints nothing', () => {
    const run = hook('session-start', startInput(), {
      HIVE_HARNESS_SESSION: join(scratch, 's.json'),
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    expect(existsSync(paths.pidMap(process.pid))).toBe(false);
  });

  it('post-tool-use maps the session to the name and handle returned by register_session', () => {
    hook('session-start', startInput());
    const run = hook(
      'post-tool-use',
      JSON.stringify({
        session_id: 'f1e2d3c4-0000-4000-8000-000000000001',
        cwd: projectDir,
        hook_event_name: 'PostToolUse',
        tool_name: 'mcp__plugin_hive-wake_hive__register_session',
        tool_input: { name: 'claude-api', description: 'Works on the API' },
        tool_response: [
          {
            type: 'text',
            text: JSON.stringify({ registered: true, name: 'claude-api', proxy_handle: 'abc123' }),
          },
        ],
      }),
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    expect(
      readPrivateJson(
        paths.sessionFile(projectKey(projectDir), 'f1e2d3c4-0000-4000-8000-000000000001'),
      ),
    ).toEqual({ name: 'claude-api', proxyHandle: 'abc123', description: 'Works on the API' });
    expect(readPrivateJson(paths.pidMap(process.pid))).toMatchObject({ name: 'claude-api' });
  });
});
