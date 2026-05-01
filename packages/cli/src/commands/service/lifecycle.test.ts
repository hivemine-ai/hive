import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CliError } from '#error/cli-error.js';

import type { ProcessResult, ProcessRunner } from './exec.js';
import { runServiceLifecycle } from './lifecycle.js';

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
  workDir = mkdtempSync(path.join(tmpdir(), 'hive-lifecycle-test-'));
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

describe('runServiceLifecycle — pre-flight', () => {
  it('throws SERVICE_NOT_INSTALLED when the unit/plist file does not exist', async () => {
    const unitPath = path.join(workDir, 'absent.service');
    let caught: unknown;
    try {
      await runServiceLifecycle('start', {
        platform: 'linux',
        unitPath,
        runner: makeRunner(new Map()).runner,
        stdout: stdoutSink,
        stderr: stderrSink,
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as CliError).code).toBe('SERVICE_NOT_INSTALLED');
    expect((caught as CliError).message).toContain('hivectl service install');
  });
});

describe('runServiceLifecycle — Linux (systemctl)', () => {
  it('start invokes systemctl start hive and reports success', async () => {
    const unitPath = path.join(workDir, 'hive.service');
    writeFileSync(unitPath, 'unit', 'utf8');
    const { runner, calls } = makeRunner(new Map());
    const result = await runServiceLifecycle('start', {
      platform: 'linux',
      unitPath,
      runner,
      stdout: stdoutSink,
      stderr: stderrSink,
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ command: 'systemctl', args: ['start', 'hive'] }]);
    expect(stdoutBuf.join('')).toContain('Service started');
  });

  it('stop invokes systemctl stop hive', async () => {
    const unitPath = path.join(workDir, 'hive.service');
    writeFileSync(unitPath, 'unit', 'utf8');
    const { runner, calls } = makeRunner(new Map());
    await runServiceLifecycle('stop', {
      platform: 'linux',
      unitPath,
      runner,
      stdout: stdoutSink,
      stderr: stderrSink,
    });
    expect(calls).toEqual([{ command: 'systemctl', args: ['stop', 'hive'] }]);
  });

  it('restart invokes systemctl restart hive (atomic)', async () => {
    const unitPath = path.join(workDir, 'hive.service');
    writeFileSync(unitPath, 'unit', 'utf8');
    const { runner, calls } = makeRunner(new Map());
    await runServiceLifecycle('restart', {
      platform: 'linux',
      unitPath,
      runner,
      stdout: stdoutSink,
      stderr: stderrSink,
    });
    expect(calls).toEqual([{ command: 'systemctl', args: ['restart', 'hive'] }]);
  });

  it('returns ok=false and writes to stderr when systemctl fails', async () => {
    const unitPath = path.join(workDir, 'hive.service');
    writeFileSync(unitPath, 'unit', 'utf8');
    const { runner } = makeRunner(
      new Map([['systemctl start hive', { status: 1, stdout: '', stderr: 'permission denied' }]]),
    );
    const result = await runServiceLifecycle('start', {
      platform: 'linux',
      unitPath,
      runner,
      stdout: stdoutSink,
      stderr: stderrSink,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('permission denied');
    expect(stderrBuf.join('')).toContain('systemctl start failed');
  });
});

describe('runServiceLifecycle — Darwin (launchctl)', () => {
  it('start invokes launchctl load -w <plist>', async () => {
    const unitPath = path.join(workDir, 'plist');
    writeFileSync(unitPath, 'plist', 'utf8');
    const { runner, calls } = makeRunner(new Map());
    await runServiceLifecycle('start', {
      platform: 'darwin',
      unitPath,
      runner,
      stdout: stdoutSink,
      stderr: stderrSink,
    });
    expect(calls).toEqual([{ command: 'launchctl', args: ['load', '-w', unitPath] }]);
  });

  it('stop invokes launchctl unload <plist>', async () => {
    const unitPath = path.join(workDir, 'plist');
    writeFileSync(unitPath, 'plist', 'utf8');
    const { runner, calls } = makeRunner(new Map());
    await runServiceLifecycle('stop', {
      platform: 'darwin',
      unitPath,
      runner,
      stdout: stdoutSink,
      stderr: stderrSink,
    });
    expect(calls).toEqual([{ command: 'launchctl', args: ['unload', unitPath] }]);
  });

  it('restart sequences unload + load -w (Mac has no atomic restart)', async () => {
    const unitPath = path.join(workDir, 'plist');
    writeFileSync(unitPath, 'plist', 'utf8');
    const { runner, calls } = makeRunner(new Map());
    await runServiceLifecycle('restart', {
      platform: 'darwin',
      unitPath,
      runner,
      stdout: stdoutSink,
      stderr: stderrSink,
    });
    expect(calls).toEqual([
      { command: 'launchctl', args: ['unload', unitPath] },
      { command: 'launchctl', args: ['load', '-w', unitPath] },
    ]);
  });

  it('restart proceeds even if unload returned non-zero (warns to stderr)', async () => {
    const unitPath = path.join(workDir, 'plist');
    writeFileSync(unitPath, 'plist', 'utf8');
    const { runner, calls } = makeRunner(
      new Map([
        [`launchctl unload ${unitPath}`, { status: 113, stdout: '', stderr: 'not loaded' }],
      ]),
    );
    const result = await runServiceLifecycle('restart', {
      platform: 'darwin',
      unitPath,
      runner,
      stdout: stdoutSink,
      stderr: stderrSink,
    });
    expect(result.ok).toBe(true);
    expect(stderrBuf.join('')).toContain('launchctl unload returned 113');
    expect(calls.length).toBe(2);
  });
});
