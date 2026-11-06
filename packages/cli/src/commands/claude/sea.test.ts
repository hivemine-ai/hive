// Opt-in smoke of the PRY-093 paths inside the single-executable binary, like
// commands/mcp/sea.test.ts: `claude install` pins the SEA executable in the
// plugin's command hooks and in the `watch` the mod launches, so they must load
// from the bundle. Runs only when HIVECTL_SEA_BINARY points at a built binary.

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { processStartTime } from '#session/pid-map.js';
import { projectKey, readPrivateJson, statePaths, writePrivateJson } from '#session/state-dir.js';

const binary = process.env['HIVECTL_SEA_BINARY'];

let dir: string;
let config: string;
let project: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hive-sea-hooks-'));
  chmodSync(dir, 0o700);
  config = join(dir, 'config');
  project = join(dir, 'project');
  mkdirSync(project);
  writePrivateJson(statePaths(config).enrollment(projectKey(project)), {
    projectPath: project,
    serverUrl: 'http://127.0.0.1:1/mcp',
    credential: 'header.eyJzY29wZSI6ImVucm9sbCJ9.sig',
    hivectlPath: binary ?? '',
    installedAt: new Date().toISOString(),
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const env = () => ({ PATH: process.env['PATH'] ?? '', HOME: dir, HIVE_CONFIG_DIR: config });

describe.skipIf(binary === undefined)('PRY-093 paths inside the SEA binary', () => {
  it('claude hook session-start writes the PID-map entry of its parent and prints the context', () => {
    const run = spawnSync(binary as string, ['claude', 'hook', 'session-start'], {
      cwd: project,
      input: JSON.stringify({ session_id: 'sea-session-1', source: 'startup', cwd: project }),
      encoding: 'utf8',
      env: { ...env(), CLAUDE_PROJECT_DIR: project },
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('mcp__plugin_hive-wake_hive__register_session');
    expect(readPrivateJson(statePaths(config).pidMap(process.pid))).toMatchObject({
      claudePid: process.pid,
      claudeStartTime: processStartTime(process.pid),
      sessionId: 'sea-session-1',
    });
  });

  it('watch in harness mode loads and refuses a state file in a folder open to others', () => {
    const open = join(dir, 'open');
    mkdirSync(open, { mode: 0o755 });
    chmodSync(open, 0o755);
    const credential = join(dir, 'enroll.jwt');
    writeFileSync(credential, 'header.eyJzY29wZSI6ImVucm9sbCJ9.sig', { mode: 0o600 });
    const run = spawnSync(
      binary as string,
      [
        'watch',
        '--session-name',
        'sea-worker',
        '--session-description',
        'SEA smoke',
        '--server',
        'http://127.0.0.1:1/mcp',
        '--credential-file',
        credential,
        '--state-file',
        join(open, 'state.json'),
        '--exec',
        '/bin/true',
      ],
      { cwd: project, encoding: 'utf8', env: env(), timeout: 30_000 },
    );
    expect(run.status).toBe(4);
    expect(run.stderr).toMatch(/^error: WATCH_STATE_FILE_INSECURE: /m);
  });

  it('watch --attach-session --once without a session exits with WATCH_ONCE_FAILED', () => {
    const run = spawnSync(binary as string, ['watch', '--attach-session', 'nobody', '--once'], {
      cwd: project,
      encoding: 'utf8',
      env: env(),
      timeout: 30_000,
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/^error: WATCH_ONCE_FAILED: /m);
  });
});
