// `hivectl watch` in harness mode as a real process (the compiled CLI; requires
// `pnpm build`) against a real Hive: kill -9 and a relaunch, and a second process
// with the same name.

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { projectKey, readPrivateJson, statePaths, writePrivateJson } from '#session/state-dir.js';
import { startHiveWorld } from '#session/test-hive.js';
import type { HiveWorld } from '#session/test-hive.js';

const CLI_ENTRY = fileURLToPath(new URL('../../../dist/main.js', import.meta.url));

let world: HiveWorld;
let scratch: string;
let configDir: string;
let projectDir: string;
const children: ChildProcess[] = [];

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'hive-harness-proc-'));
  chmodSync(scratch, 0o700);
  configDir = join(scratch, 'config');
  projectDir = join(scratch, 'project');
  mkdirSync(projectDir);
  world = await startHiveWorld({ listenLeaseMs: 60_000 });
  writePrivateJson(statePaths(configDir).enrollment(projectKey(projectDir)), {
    projectPath: projectDir,
    serverUrl: world.url,
    credential: world.enrollmentCredential,
    hivectlPath: CLI_ENTRY,
    installedAt: new Date().toISOString(),
  });
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  await world.cleanup();
  rmSync(scratch, { recursive: true, force: true });
});

function launch(): { child: ChildProcess; stderr: string[]; exit: Promise<number | null> } {
  const child = spawn(
    process.execPath,
    [
      CLI_ENTRY,
      'watch',
      '--session-name',
      'nightly-worker',
      '--session-description',
      'Runs the nightly report',
      '--exec',
      process.execPath,
      '--',
      '-e',
      'process.exit(0)',
    ],
    {
      cwd: projectDir,
      env: { PATH: process.env['PATH'] ?? '', HOME: scratch, HIVE_CONFIG_DIR: configDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  children.push(child);
  const stderr: string[] = [];
  child.stderr?.on('data', (c: Buffer) => stderr.push(c.toString()));
  const exit = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return { child, stderr, exit };
}

function harnessStates(): { path: string; watchPid: number; agentId: string }[] {
  const dir = join(configDir, 'state', 'harness');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const path = join(dir, f);
      const state = readPrivateJson(path) as { watchPid: number; agentId: string };
      return { path, watchPid: state.watchPid, agentId: state.agentId };
    });
}

describe('watch harness mode (process)', () => {
  it('after kill -9, a relaunch with the same name renews the persisted token: no agent_claimed', async () => {
    const first = launch();
    await expect.poll(() => harnessStates().length, { timeout: 15_000 }).toBe(1);
    const [state] = harnessStates();
    await expect.poll(() => world.isOnline(state?.agentId ?? ''), { timeout: 15_000 }).toBe(true);
    first.child.kill('SIGKILL');
    await first.exit;

    const second = launch();
    await expect
      .poll(() => harnessStates().map((s) => s.watchPid), { timeout: 15_000 })
      .toEqual([second.child.pid]);
    expect(harnessStates()[0]?.agentId).toBe(state?.agentId);
    await expect.poll(() => world.isOnline(state?.agentId ?? ''), { timeout: 15_000 }).toBe(true);
    expect(await world.auditCount('agent_claimed')).toBe(0);
    expect(await world.auditCount('agent_enrolled')).toBe(1);

    second.child.kill('SIGTERM');
    expect(await second.exit).toBe(130);
    expect(harnessStates()).toEqual([]);
  }, 60_000);

  it('a second process with the same name in the same folder exits 4 with WATCH_SESSION_NAME_IN_USE', async () => {
    const first = launch();
    await expect.poll(() => harnessStates().length, { timeout: 15_000 }).toBe(1);
    const agentId = harnessStates()[0]?.agentId ?? '';
    await expect.poll(() => world.isOnline(agentId), { timeout: 15_000 }).toBe(true);

    const second = launch();
    expect(await second.exit).toBe(4);
    expect(second.stderr.join('')).toMatch(/^error: WATCH_SESSION_NAME_IN_USE: /m);
    expect(world.isOnline(agentId)).toBe(true);
    first.child.kill('SIGTERM');
    await first.exit;
  }, 60_000);
});
