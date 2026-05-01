import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CliError } from '#error/cli-error.js';

import type { ProcessResult, ProcessRunner } from './exec.js';
import { runServiceUninstall } from './uninstall.js';

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
  workDir = mkdtempSync(path.join(tmpdir(), 'hive-uninstall-test-'));
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

describe('runServiceUninstall — idempotent', () => {
  it('returns removed=false when the unit does not exist (idempotent)', async () => {
    const unitPath = path.join(workDir, 'absent.service');
    const { runner } = makeRunner(new Map());
    const result = await runServiceUninstall({
      platform: 'linux',
      runner,
      isRoot: () => true,
      unitPath,
      stdout: stdoutSink,
      stderr: stderrSink,
    });
    expect(result.removed).toBe(false);
    expect(stdoutBuf.join('')).toContain('not installed');
  });
});

describe('runServiceUninstall — Linux', () => {
  it('throws ROOT_REQUIRED when not root', async () => {
    const unitPath = path.join(workDir, 'hive.service');
    writeFileSync(unitPath, 'unit', 'utf8');
    let caught: unknown;
    try {
      await runServiceUninstall({
        platform: 'linux',
        runner: makeRunner(new Map()).runner,
        isRoot: () => false,
        unitPath,
        stdout: stdoutSink,
        stderr: stderrSink,
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as CliError).code).toBe('ROOT_REQUIRED');
  });

  it('removes the unit + calls daemon-reload when service is inactive', async () => {
    const unitPath = path.join(workDir, 'hive.service');
    writeFileSync(unitPath, 'unit', 'utf8');
    const { runner, calls } = makeRunner(
      new Map([['systemctl is-active hive', { status: 3, stdout: 'inactive\n', stderr: '' }]]),
    );
    const result = await runServiceUninstall({
      platform: 'linux',
      runner,
      isRoot: () => true,
      unitPath,
      stdout: stdoutSink,
      stderr: stderrSink,
    });
    expect(result.removed).toBe(true);
    expect(result.stoppedFirst).toBe(false);
    expect(existsSync(unitPath)).toBe(false);
    const cmds = calls.map((c) => `${c.command} ${c.args.join(' ')}`);
    expect(cmds).toContain('systemctl is-active hive');
    expect(cmds).toContain('systemctl daemon-reload');
    expect(cmds).not.toContain('systemctl stop hive');
  });

  it('stops the service first + emits warning when systemctl is-active = active', async () => {
    const unitPath = path.join(workDir, 'hive.service');
    writeFileSync(unitPath, 'unit', 'utf8');
    const { runner, calls } = makeRunner(
      new Map([['systemctl is-active hive', { status: 0, stdout: 'active\n', stderr: '' }]]),
    );
    const result = await runServiceUninstall({
      platform: 'linux',
      runner,
      isRoot: () => true,
      unitPath,
      stdout: stdoutSink,
      stderr: stderrSink,
    });
    expect(result.stoppedFirst).toBe(true);
    expect(stderrBuf.join('')).toContain('active; stopping');
    const cmds = calls.map((c) => `${c.command} ${c.args.join(' ')}`);
    expect(cmds).toContain('systemctl stop hive');
  });
});

describe('runServiceUninstall — Darwin', () => {
  it('does NOT require root', async () => {
    const unitPath = path.join(workDir, 'plist');
    writeFileSync(unitPath, 'plist', 'utf8');
    const { runner } = makeRunner(
      new Map([['launchctl list com.hivemine.hivectl', { status: 1, stdout: '', stderr: '' }]]),
    );
    const result = await runServiceUninstall({
      platform: 'darwin',
      runner,
      unitPath,
      stdout: stdoutSink,
      stderr: stderrSink,
    });
    expect(result.removed).toBe(true);
  });

  it('unloads + warns when launchctl list reports the agent loaded', async () => {
    const unitPath = path.join(workDir, 'plist');
    writeFileSync(unitPath, 'plist', 'utf8');
    const { runner, calls } = makeRunner(
      new Map([
        ['launchctl list com.hivemine.hivectl', { status: 0, stdout: '{ ... }', stderr: '' }],
      ]),
    );
    const result = await runServiceUninstall({
      platform: 'darwin',
      runner,
      unitPath,
      stdout: stdoutSink,
      stderr: stderrSink,
    });
    expect(result.stoppedFirst).toBe(true);
    expect(stderrBuf.join('')).toContain('loaded; unloading');
    const cmds = calls.map((c) => `${c.command} ${c.args.join(' ')}`);
    expect(cmds.some((c) => c.startsWith('launchctl unload'))).toBe(true);
  });
});
