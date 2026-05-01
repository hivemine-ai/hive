import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ProcessResult, ProcessRunner } from './exec.js';
import { runServiceStatus } from './status.js';

let workDir: string;
let stdoutBuf: string[];
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
  workDir = mkdtempSync(path.join(tmpdir(), 'hive-status-test-'));
  stdoutBuf = [];
  stdoutSink = makeWritable(stdoutBuf);
  stderrSink = makeWritable([]);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function makeRunner(replies: Map<string, ProcessResult>): ProcessRunner {
  return {
    run(command, args) {
      const key = `${command} ${args.join(' ')}`;
      // Match by exact key first, then prefix (cmd alone)
      const exact = replies.get(key);
      if (exact !== undefined) return exact;
      const prefix = replies.get(command);
      if (prefix !== undefined) return prefix;
      return { status: 0, stdout: '', stderr: '' };
    },
  };
}

describe('runServiceStatus — not installed', () => {
  it('returns exitCode=1 + installed=false when the unit/plist is absent', async () => {
    const result = await runServiceStatus(
      {},
      {
        platform: 'linux',
        runner: makeRunner(new Map()),
        unitPath: path.join(workDir, 'absent.service'),
        stdout: stdoutSink,
        stderr: stderrSink,
      },
    );
    expect(result.installed).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(stdoutBuf.join('')).toContain('Installed:   no');
  });
});

describe('runServiceStatus — Linux', () => {
  it('reports running + PID + Uptime when ActiveState=active', async () => {
    const unitPath = path.join(workDir, 'hive.service');
    writeFileSync(unitPath, 'unit', 'utf8');
    const showOut = [
      'ActiveState=active',
      'MainPID=12345',
      `ActiveEnterTimestamp=${new Date(Date.now() - 60_000).toUTCString()}`,
    ].join('\n');
    const journalOut = '2026-05-02 14:00:00 hive[12345]: wire_started';
    const runner = makeRunner(
      new Map([
        ['systemctl', { status: 0, stdout: showOut, stderr: '' }],
        ['journalctl', { status: 0, stdout: journalOut, stderr: '' }],
      ]),
    );
    const result = await runServiceStatus(
      {},
      { platform: 'linux', unitPath, runner, stdout: stdoutSink, stderr: stderrSink },
    );
    expect(result.exitCode).toBe(0);
    expect(result.status.state).toBe('running');
    expect(stdoutBuf.join('')).toContain('PID:         12345');
    expect(stdoutBuf.join('')).toContain(
      'Last log:    2026-05-02 14:00:00 hive[12345]: wire_started',
    );
  });

  it('reports stopped + exitCode=1 when ActiveState=inactive', async () => {
    const unitPath = path.join(workDir, 'hive.service');
    writeFileSync(unitPath, 'unit', 'utf8');
    const showOut = ['ActiveState=inactive', 'MainPID=0', 'ActiveEnterTimestamp='].join('\n');
    const runner = makeRunner(new Map([['systemctl', { status: 0, stdout: showOut, stderr: '' }]]));
    const result = await runServiceStatus(
      {},
      { platform: 'linux', unitPath, runner, stdout: stdoutSink, stderr: stderrSink },
    );
    expect(result.exitCode).toBe(1);
    expect(result.status.state).toBe('stopped');
    expect(stdoutBuf.join('')).toContain('State:       stopped');
  });

  it('renders Recent logs block when --logs N is passed', async () => {
    const unitPath = path.join(workDir, 'hive.service');
    writeFileSync(unitPath, 'unit', 'utf8');
    const showOut = [
      'ActiveState=active',
      'MainPID=42',
      `ActiveEnterTimestamp=${new Date(Date.now() - 60_000).toUTCString()}`,
    ].join('\n');
    const journalOut = ['line A', 'line B', 'line C', 'line D', 'line E'].join('\n');
    const runner = makeRunner(
      new Map([
        ['systemctl', { status: 0, stdout: showOut, stderr: '' }],
        ['journalctl', { status: 0, stdout: journalOut, stderr: '' }],
      ]),
    );
    await runServiceStatus(
      { logs: 3 },
      { platform: 'linux', unitPath, runner, stdout: stdoutSink, stderr: stderrSink },
    );
    const out = stdoutBuf.join('');
    expect(out).toContain('Recent logs:');
    expect(out).toContain('  line C');
    expect(out).toContain('  line D');
    expect(out).toContain('  line E');
    expect(out).not.toContain('line A');
    expect(out).not.toContain('Last log:');
  });
});

describe('runServiceStatus — Darwin', () => {
  it('reports running + PID when launchctl list shows positive PID', async () => {
    const unitPath = path.join(workDir, 'plist');
    writeFileSync(unitPath, 'plist', 'utf8');
    const listOut = [
      '{',
      '\t"Label" = "com.hivemine.hivectl";',
      '\t"PID" = 4242;',
      '\t"LastExitStatus" = 0;',
      '};',
    ].join('\n');
    const runner = makeRunner(new Map([['launchctl', { status: 0, stdout: listOut, stderr: '' }]]));
    const result = await runServiceStatus(
      {},
      { platform: 'darwin', unitPath, runner, stdout: stdoutSink, stderr: stderrSink },
    );
    expect(result.exitCode).toBe(0);
    expect(result.status.pid).toBe(4242);
    expect(result.status.uptimeMs).toBeNull(); // launchctl doesn't expose uptime
    expect(stdoutBuf.join('')).toContain('Uptime:      -');
  });

  it('reports stopped when launchctl list output has PID=0 + LastExitStatus=0', async () => {
    const unitPath = path.join(workDir, 'plist');
    writeFileSync(unitPath, 'plist', 'utf8');
    const listOut = ['{', '\t"PID" = 0;', '\t"LastExitStatus" = 0;', '};'].join('\n');
    const runner = makeRunner(new Map([['launchctl', { status: 0, stdout: listOut, stderr: '' }]]));
    const result = await runServiceStatus(
      {},
      { platform: 'darwin', unitPath, runner, stdout: stdoutSink, stderr: stderrSink },
    );
    expect(result.exitCode).toBe(1);
    expect(result.status.state).toBe('stopped');
  });

  it('tails the macStderrPath log when --logs N and running', async () => {
    const unitPath = path.join(workDir, 'plist');
    writeFileSync(unitPath, 'plist', 'utf8');
    const listOut = ['{', '\t"PID" = 99;', '\t"LastExitStatus" = 0;', '};'].join('\n');
    const tailOut = ['err line 1', 'err line 2'].join('\n');
    const runner = makeRunner(
      new Map([
        ['launchctl', { status: 0, stdout: listOut, stderr: '' }],
        ['tail', { status: 0, stdout: tailOut, stderr: '' }],
      ]),
    );
    await runServiceStatus(
      { logs: 2 },
      {
        platform: 'darwin',
        unitPath,
        runner,
        macStderrPath: '/Users/op/Library/Logs/Hive/hive.err',
        stdout: stdoutSink,
        stderr: stderrSink,
      },
    );
    const out = stdoutBuf.join('');
    expect(out).toContain('Recent logs:');
    expect(out).toContain('  err line 1');
    expect(out).toContain('  err line 2');
  });
});
