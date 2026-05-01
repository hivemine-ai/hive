// Pure parsers for `systemctl show` and `launchctl list` output.
// `service status` shells out to one of these, then renders a uniform
// `ServiceStatus` shape so the operator never sees the OS-specific format.

export type ServiceState = 'running' | 'stopped' | 'error' | 'not-installed';

export interface ServiceStatus {
  state: ServiceState;
  pid: number | null;
  uptimeMs: number | null;
}

/**
 * Parses `systemctl show hive --property=ActiveState,MainPID,ActiveEnterTimestamp`.
 *
 * Stable key=value lines, one per property. Missing or unparseable values
 * collapse to `null` rather than throwing — `service status` is a read-only
 * query and shouldn't fail because systemd's output drifted.
 */
export function parseSystemctlShow(stdout: string, now: number = Date.now()): ServiceStatus {
  const lines = stdout.split('\n');
  let activeState: string | undefined;
  let mainPid: string | undefined;
  let activeEnter: string | undefined;
  for (const line of lines) {
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx);
    const value = line.slice(idx + 1);
    if (key === 'ActiveState') activeState = value;
    else if (key === 'MainPID') mainPid = value;
    else if (key === 'ActiveEnterTimestamp') activeEnter = value;
  }
  const state = mapActiveStateToServiceState(activeState);
  const pid = parsePid(mainPid);
  const uptimeMs = state === 'running' ? parseSystemdTimestamp(activeEnter, now) : null;
  return { state, pid, uptimeMs };
}

function mapActiveStateToServiceState(activeState: string | undefined): ServiceState {
  switch (activeState) {
    case 'active':
      return 'running';
    case 'inactive':
    case 'deactivating':
      return 'stopped';
    case 'failed':
      return 'error';
    case undefined:
    case '':
      return 'not-installed';
    default:
      // 'activating', 'reloading', etc. — unknown maps to error to avoid
      // claiming "running" optimistically.
      return 'error';
  }
}

function parsePid(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

/**
 * systemd timestamps look like `Sat 2026-05-02 13:14:00 UTC` or
 * `2026-05-02 13:14:00 UTC`. Returns the elapsed milliseconds since the given
 * `now`, or `null` if unparseable.
 */
function parseSystemdTimestamp(raw: string | undefined, now: number): number | null {
  if (raw === undefined || raw === '') return null;
  // strip leading day name (`Sat ` etc.) — `Date.parse` doesn't need it
  const stripped = raw.replace(/^[A-Za-z]{3}\s+/, '');
  const parsed = Date.parse(stripped);
  if (!Number.isFinite(parsed)) return null;
  const diff = now - parsed;
  if (diff < 0) return null;
  return diff;
}

/**
 * Parses `launchctl list <label>`. The output is a Property List dict
 * containing keys like `PID`, `LastExitStatus`, `Label`. We only need PID
 * (running) + LastExitStatus (error if non-zero on a non-running service).
 *
 * launchctl does NOT expose a startup timestamp, so `uptimeMs` is always
 * `null` on Mac. The operator sees `Uptime: -` in the rendered status.
 */
export function parseLaunchctlList(stdout: string): ServiceStatus {
  const trimmed = stdout.trim();
  if (trimmed === '') {
    return { state: 'not-installed', pid: null, uptimeMs: null };
  }
  const pidMatch = /"?PID"?\s*=\s*(-?\d+)/.exec(trimmed);
  const exitMatch = /"?LastExitStatus"?\s*=\s*(-?\d+)/.exec(trimmed);
  const pid = pidMatch ? Number(pidMatch[1]) : null;
  const lastExit = exitMatch ? Number(exitMatch[1]) : null;
  if (pid !== null && pid > 0) {
    return { state: 'running', pid, uptimeMs: null };
  }
  if (lastExit !== null && lastExit !== 0) {
    return { state: 'error', pid: null, uptimeMs: null };
  }
  return { state: 'stopped', pid: null, uptimeMs: null };
}

/**
 * Formats a millisecond duration as a short human string: `2h 14m`, `45m`,
 * `12s`. Returns `'-'` for `null` (never-started or systemd output gap).
 */
export function formatUptime(ms: number | null): string {
  if (ms === null || ms < 0) return '-';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return `${hours}h ${remainingMinutes}m`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return `${days}d ${remainingHours}h`;
}

export interface RenderStatusInput {
  installed: boolean;
  supervisor: 'systemd' | 'launchd';
  status: ServiceStatus;
  /** Optional last log line. `undefined` skips the line entirely. */
  lastLog?: string;
  /** Optional N>0 log lines. Replaces `lastLog` when provided. */
  recentLogs?: string[];
}

/**
 * Builds the uniform multi-line output of `hivectl service status`. Pure —
 * accepts a fully resolved `RenderStatusInput`, returns the rendered string.
 */
export function renderServiceStatus(input: RenderStatusInput): string {
  const lines: string[] = [];
  lines.push('Service:     hive');
  if (!input.installed) {
    lines.push(`Installed:   no`);
    lines.push(`State:       not-installed`);
    return lines.join('\n');
  }
  lines.push(`Installed:   yes (${input.supervisor})`);
  lines.push(`State:       ${input.status.state}`);
  if (input.status.state === 'running') {
    if (input.status.pid !== null) lines.push(`PID:         ${input.status.pid}`);
    lines.push(`Uptime:      ${formatUptime(input.status.uptimeMs)}`);
  }
  if (input.status.state === 'running') {
    if (input.recentLogs !== undefined && input.recentLogs.length > 0) {
      lines.push('');
      lines.push('Recent logs:');
      for (const line of input.recentLogs) lines.push(`  ${line}`);
    } else if (input.lastLog !== undefined && input.lastLog !== '') {
      lines.push(`Last log:    ${input.lastLog}`);
    }
  }
  return lines.join('\n');
}
