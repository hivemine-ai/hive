import { describe, expect, it } from 'vitest';

import {
  formatUptime,
  parseLaunchctlList,
  parseSystemctlShow,
  renderServiceStatus,
} from './status-parser.js';

describe('parseSystemctlShow', () => {
  const now = Date.parse('2026-05-02T15:00:00Z');

  it('maps ActiveState=active to running and computes uptime', () => {
    const stdout = [
      'ActiveState=active',
      'MainPID=12345',
      'ActiveEnterTimestamp=Sat 2026-05-02 12:46:00 UTC',
    ].join('\n');
    const status = parseSystemctlShow(stdout, now);
    expect(status.state).toBe('running');
    expect(status.pid).toBe(12345);
    // Started at 12:46:00, now 15:00:00 → 2h 14m → 8040000ms
    expect(status.uptimeMs).toBe(2 * 3600 * 1000 + 14 * 60 * 1000);
  });

  it('maps ActiveState=inactive to stopped', () => {
    const stdout = ['ActiveState=inactive', 'MainPID=0', 'ActiveEnterTimestamp='].join('\n');
    const status = parseSystemctlShow(stdout, now);
    expect(status.state).toBe('stopped');
    expect(status.pid).toBeNull();
    expect(status.uptimeMs).toBeNull();
  });

  it('maps ActiveState=failed to error', () => {
    const stdout = ['ActiveState=failed', 'MainPID=0', 'ActiveEnterTimestamp='].join('\n');
    const status = parseSystemctlShow(stdout, now);
    expect(status.state).toBe('error');
  });

  it('maps missing ActiveState to not-installed', () => {
    const stdout = ['ActiveState=', 'MainPID=0', 'ActiveEnterTimestamp='].join('\n');
    const status = parseSystemctlShow(stdout, now);
    expect(status.state).toBe('not-installed');
  });

  it('maps unknown ActiveState to error (no optimistic running)', () => {
    const stdout = ['ActiveState=activating', 'MainPID=999'].join('\n');
    const status = parseSystemctlShow(stdout, now);
    expect(status.state).toBe('error');
  });

  it('ignores lines without "=" gracefully', () => {
    const stdout = [
      'ActiveState=active',
      'noise without equals',
      'MainPID=12',
      '',
      'ActiveEnterTimestamp=Sat 2026-05-02 14:59:00 UTC',
    ].join('\n');
    const status = parseSystemctlShow(stdout, now);
    expect(status.state).toBe('running');
    expect(status.pid).toBe(12);
    expect(status.uptimeMs).toBe(60_000);
  });

  it('returns pid=null on negative or non-integer MainPID', () => {
    const stdout = ['ActiveState=active', 'MainPID=-1'].join('\n');
    expect(parseSystemctlShow(stdout, now).pid).toBeNull();
  });

  it('returns uptime=null when running but timestamp is unparseable', () => {
    const stdout = ['ActiveState=active', 'MainPID=42', 'ActiveEnterTimestamp=garbage'].join('\n');
    expect(parseSystemctlShow(stdout, now).uptimeMs).toBeNull();
  });

  it('returns uptime=null when timestamp is in the future (clock skew)', () => {
    const stdout = [
      'ActiveState=active',
      'MainPID=42',
      'ActiveEnterTimestamp=Sun 2026-05-03 00:00:00 UTC',
    ].join('\n');
    expect(parseSystemctlShow(stdout, now).uptimeMs).toBeNull();
  });
});

describe('parseLaunchctlList', () => {
  it('returns running with pid when PID is positive', () => {
    const stdout = [
      '{',
      '\t"LimitLoadToSessionType" = "Aqua";',
      '\t"Label" = "com.hivemine.hivectl";',
      '\t"OnDemand" = false;',
      '\t"LastExitStatus" = 0;',
      '\t"PID" = 4242;',
      '\t"Program" = "/usr/local/bin/hivectl";',
      '};',
    ].join('\n');
    const status = parseLaunchctlList(stdout);
    expect(status.state).toBe('running');
    expect(status.pid).toBe(4242);
    expect(status.uptimeMs).toBeNull(); // launchctl never reports start time
  });

  it('returns stopped when PID is 0 and LastExitStatus is 0', () => {
    const stdout = ['{', '\t"PID" = 0;', '\t"LastExitStatus" = 0;', '};'].join('\n');
    expect(parseLaunchctlList(stdout).state).toBe('stopped');
  });

  it('returns error when LastExitStatus is non-zero (and not running)', () => {
    const stdout = ['{', '\t"LastExitStatus" = 1;', '};'].join('\n');
    expect(parseLaunchctlList(stdout).state).toBe('error');
  });

  it('returns not-installed on empty stdout', () => {
    expect(parseLaunchctlList('').state).toBe('not-installed');
    expect(parseLaunchctlList('   ').state).toBe('not-installed');
  });

  it('handles negative PID (launchctl shows "-" sometimes)', () => {
    const stdout = ['{', '\t"PID" = -1;', '\t"LastExitStatus" = 0;', '};'].join('\n');
    expect(parseLaunchctlList(stdout).state).toBe('stopped');
  });
});

describe('formatUptime', () => {
  it('formats sub-minute seconds', () => {
    expect(formatUptime(45_000)).toBe('45s');
  });

  it('formats sub-hour minutes', () => {
    expect(formatUptime(45 * 60 * 1000)).toBe('45m');
  });

  it('formats hours+minutes', () => {
    expect(formatUptime(2 * 3600 * 1000 + 14 * 60 * 1000)).toBe('2h 14m');
  });

  it('formats days+hours past 24h', () => {
    expect(formatUptime(36 * 3600 * 1000)).toBe('1d 12h');
  });

  it('returns "-" for null and negative', () => {
    expect(formatUptime(null)).toBe('-');
    expect(formatUptime(-1)).toBe('-');
  });

  it('formats 0ms as 0s', () => {
    expect(formatUptime(0)).toBe('0s');
  });
});

describe('renderServiceStatus', () => {
  it('renders not-installed (no PID/Uptime/Last log)', () => {
    const out = renderServiceStatus({
      installed: false,
      supervisor: 'systemd',
      status: { state: 'not-installed', pid: null, uptimeMs: null },
    });
    expect(out).toBe(
      ['Service:     hive', 'Installed:   no', 'State:       not-installed'].join('\n'),
    );
  });

  it('renders running with PID + Uptime + Last log', () => {
    const out = renderServiceStatus({
      installed: true,
      supervisor: 'systemd',
      status: { state: 'running', pid: 12345, uptimeMs: 2 * 3600 * 1000 + 14 * 60 * 1000 },
      lastLog: 'wire_started httpHost=127.0.0.1 httpPort=4123',
    });
    expect(out).toContain('Installed:   yes (systemd)');
    expect(out).toContain('State:       running');
    expect(out).toContain('PID:         12345');
    expect(out).toContain('Uptime:      2h 14m');
    expect(out).toContain('Last log:    wire_started httpHost=127.0.0.1 httpPort=4123');
  });

  it('omits PID + Uptime + Last log when stopped', () => {
    const out = renderServiceStatus({
      installed: true,
      supervisor: 'launchd',
      status: { state: 'stopped', pid: null, uptimeMs: null },
      lastLog: 'shutdown signal received',
    });
    expect(out).toContain('State:       stopped');
    expect(out).not.toContain('PID:');
    expect(out).not.toContain('Uptime:');
    expect(out).not.toContain('Last log:');
  });

  it('renders Recent logs block when recentLogs is non-empty (overrides lastLog)', () => {
    const out = renderServiceStatus({
      installed: true,
      supervisor: 'systemd',
      status: { state: 'running', pid: 1, uptimeMs: 1000 },
      lastLog: 'this is ignored',
      recentLogs: ['line one', 'line two', 'line three'],
    });
    expect(out).toContain('Recent logs:');
    expect(out).toContain('  line one');
    expect(out).toContain('  line two');
    expect(out).toContain('  line three');
    expect(out).not.toContain('Last log:');
    expect(out).not.toContain('this is ignored');
  });

  it('renders Uptime: - when running but uptime is null (Mac case)', () => {
    const out = renderServiceStatus({
      installed: true,
      supervisor: 'launchd',
      status: { state: 'running', pid: 4242, uptimeMs: null },
    });
    expect(out).toContain('Uptime:      -');
  });
});
