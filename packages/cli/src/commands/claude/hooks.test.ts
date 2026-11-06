import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { publishProxyEntry } from '#session/pid-map.js';
import { projectKey, readPrivateJson, statePaths, writePrivateJson } from '#session/state-dir.js';
import type { StatePaths } from '#session/state-dir.js';

import { postToolUseHook, sessionStartHook } from './hooks.js';
import type { HookDeps } from './hooks.js';

const CLAUDE_PID = 4242;
const START = 'Thu Nov  6 10:00:00 2026';
const REGISTER = 'mcp__plugin_hive-wake_hive__register_session';
const STATUS = 'mcp__plugin_hive-wake_hive__session_status';

let scratch: string;
let configDir: string;
let projectDir: string;
let paths: StatePaths;
let key: string;
let alive: Record<number, string>;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'hive-hooks-'));
  chmodSync(scratch, 0o700);
  configDir = join(scratch, 'config');
  projectDir = join(scratch, 'project');
  mkdirSync(projectDir);
  paths = statePaths(configDir);
  key = projectKey(projectDir);
  alive = { [CLAUDE_PID]: START };
  writePrivateJson(paths.enrollment(key), {
    projectPath: projectDir,
    serverUrl: 'http://127.0.0.1:1/mcp',
    credential: 'enroll.jwt',
    hivectlPath: 'hivectl',
    installedAt: new Date().toISOString(),
  });
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function deps(env: NodeJS.ProcessEnv = {}): HookDeps {
  return {
    env: { HIVE_CONFIG_DIR: configDir, CLAUDE_PROJECT_DIR: projectDir, ...env },
    home: scratch,
    cwd: projectDir,
    claudePid: CLAUDE_PID,
    startTimeOf: (pid) => alive[pid],
  };
}

function start(input: Record<string, unknown>, env: NodeJS.ProcessEnv = {}): string {
  return sessionStartHook(JSON.stringify({ cwd: projectDir, ...input }), deps(env));
}

function contextOf(stdout: string): string {
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
  };
  expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
  return parsed.hookSpecificOutput.additionalContext;
}

function saveSession(sessionId: string, value: Record<string, unknown>): void {
  writePrivateJson(join(paths.sessionsDir(key), `${sessionId}.json`), value);
}

describe('SessionStart hook', () => {
  it('writes the PID-map entry of the parent claude and asks the model to propose a name when none is saved', () => {
    const out = start({ session_id: 's-1', source: 'startup' });
    expect(readPrivateJson(paths.pidMap(CLAUDE_PID))).toEqual({
      claudePid: CLAUDE_PID,
      claudeStartTime: START,
      sessionId: 's-1',
      source: 'startup',
    });
    const context = contextOf(out);
    expect(context).toContain('mcp__plugin_hive-wake_hive__session_status');
    expect(context).toContain('mcp__plugin_hive-wake_hive__register_session');
    expect(context).toMatch(/ToolSearch/);
    expect(context).toMatch(/confirm/i);
    expect(context).toMatch(/name_in_use/);
    expect(context).toMatch(/\/mcp/);
    expect(context).toMatch(/untrusted/i);
  });

  it('on resume with a saved name, records the name and description and only informs the model', () => {
    saveSession('s-1', { name: 'claude-api', proxyHandle: 'h1', description: 'Works on the API' });
    const out = start({ session_id: 's-1', source: 'resume' });
    expect(readPrivateJson(paths.pidMap(CLAUDE_PID))).toMatchObject({
      sessionId: 's-1',
      source: 'resume',
      name: 'claude-api',
      description: 'Works on the API',
    });
    const context = contextOf(out);
    expect(context).toContain('"claude-api"');
    expect(context).not.toMatch(/propose/i);
    expect(context).toMatch(/\/mcp/);
  });

  function registeredProxy(name = 'claude-api'): void {
    publishProxyEntry(paths, {
      claudePid: CLAUDE_PID,
      claudeStartTime: START,
      proxyHandle: 'handle-1',
      socketPath: '/tmp/x.sock',
      registered: true,
      name,
    });
  }

  it('on /clear keeps the identity and the description of the registered proxy for the new session id', () => {
    start({ session_id: 's-1', source: 'startup' });
    writePrivateJson(paths.pidMap(CLAUDE_PID), {
      claudePid: CLAUDE_PID,
      claudeStartTime: START,
      sessionId: 's-1',
      source: 'startup',
      name: 'claude-api',
      description: 'Works on the API',
    });
    registeredProxy();
    const out = start({ session_id: 's-2', source: 'clear' });
    expect(readPrivateJson(paths.pidMap(CLAUDE_PID))).toMatchObject({
      sessionId: 's-2',
      source: 'clear',
      name: 'claude-api',
      description: 'Works on the API',
    });
    expect(readPrivateJson(join(paths.sessionsDir(key), 's-2.json'))).toEqual({
      name: 'claude-api',
      proxyHandle: 'handle-1',
      description: 'Works on the API',
    });
    expect(contextOf(out)).toContain('"claude-api"');
  });

  it.each(['resume', 'compact', 'startup'])(
    'on %s of a session id without a saved name does not inherit the name of the registered proxy',
    (source) => {
      registeredProxy();
      const out = start({ session_id: 's-9', source });
      const entry = readPrivateJson(paths.pidMap(CLAUDE_PID)) as Record<string, unknown>;
      expect(entry['name']).toBeUndefined();
      expect(existsSync(join(paths.sessionsDir(key), 's-9.json'))).toBe(false);
      expect(contextOf(out)).not.toContain('"claude-api"');
    },
  );

  it('on /resume of a session saved as Y while the proxy is registered as X keeps X and says the names differ', () => {
    saveSession('s-1', { name: 'old-name', proxyHandle: 'h0', description: 'Old work' });
    registeredProxy('claude-api');
    const out = start({ session_id: 's-1', source: 'resume' });
    expect(readPrivateJson(paths.pidMap(CLAUDE_PID))).toMatchObject({
      sessionId: 's-1',
      source: 'resume',
      name: 'claude-api',
    });
    const context = contextOf(out);
    expect(context).toContain('"claude-api"');
    expect(context).toContain('"old-name"');
    expect(context).not.toMatch(/is the Hive agent "old-name"/);
    expect(context).toContain('mcp__plugin_hive-wake_hive__session_status');
    expect(readPrivateJson(join(paths.sessionsDir(key), 's-1.json'))).toMatchObject({
      name: 'old-name',
    });
  });

  it('removes orphan PID-map and proxy entries (dead process or reused PID)', () => {
    const dead = 5151;
    const reused = 6161;
    alive[reused] = 'another start';
    for (const pid of [dead, reused]) {
      writePrivateJson(paths.pidMap(pid), {
        claudePid: pid,
        claudeStartTime: START,
        sessionId: `s-${String(pid)}`,
        source: 'startup',
      });
      publishProxyEntry(paths, {
        claudePid: pid,
        claudeStartTime: START,
        proxyHandle: 'h',
        socketPath: '/tmp/y.sock',
        registered: false,
      });
    }
    start({ session_id: 's-1', source: 'startup' });
    for (const pid of [dead, reused]) {
      expect(existsSync(paths.pidMap(pid))).toBe(false);
      expect(existsSync(paths.proxy(pid))).toBe(false);
    }
    expect(existsSync(paths.pidMap(CLAUDE_PID))).toBe(true);
  });

  it('is silent with the harness marker: writes nothing and announces nothing', () => {
    expect(
      start({ session_id: 's-1', source: 'startup' }, { HIVE_HARNESS_SESSION: '/s.json' }),
    ).toBe('');
    expect(existsSync(paths.pidMap(CLAUDE_PID))).toBe(false);
  });

  it('stays silent in a folder without a Hive enrollment', () => {
    rmSync(paths.enrollment(key));
    expect(start({ session_id: 's-1', source: 'startup' })).toBe('');
    expect(existsSync(paths.pidMap(CLAUDE_PID))).toBe(false);
  });

  it('throws on malformed input (the runner turns it into exit 0 without context)', () => {
    expect(() => sessionStartHook('not json', deps())).toThrow();
    expect(() => sessionStartHook('{"source":"startup"}', deps())).toThrow();
  });
});

describe('PostToolUse hook', () => {
  function post(input: Record<string, unknown>, env: NodeJS.ProcessEnv = {}): void {
    postToolUseHook(JSON.stringify({ cwd: projectDir, ...input }), deps(env));
  }

  const registeredText = JSON.stringify({
    registered: true,
    name: 'claude-api',
    agent_ref: 'claude-api@leo.hive',
    proxy_handle: 'handle-9',
  });

  it('after register_session, maps the session id to the name and the proxy handle, and names the PID-map entry', () => {
    start({ session_id: 's-1', source: 'startup' });
    post({
      session_id: 's-1',
      tool_name: REGISTER,
      tool_input: { name: 'claude-api', description: 'Works on the API' },
      tool_response: [{ type: 'text', text: registeredText }],
    });
    expect(readPrivateJson(join(paths.sessionsDir(key), 's-1.json'))).toEqual({
      name: 'claude-api',
      proxyHandle: 'handle-9',
      description: 'Works on the API',
    });
    expect(readPrivateJson(paths.pidMap(CLAUDE_PID))).toMatchObject({
      sessionId: 's-1',
      name: 'claude-api',
      description: 'Works on the API',
    });
  });

  it('accepts the response as an object with structuredContent and from session_status', () => {
    start({ session_id: 's-1', source: 'startup' });
    post({
      session_id: 's-1',
      tool_name: STATUS,
      tool_input: {},
      tool_response: { structuredContent: JSON.parse(registeredText) as unknown },
    });
    expect(readPrivateJson(join(paths.sessionsDir(key), 's-1.json'))).toEqual({
      name: 'claude-api',
      proxyHandle: 'handle-9',
    });
  });

  it('writes nothing for an unregistered status, an error result, another tool, or with the marker', () => {
    const unregistered = JSON.stringify({ registered: false, name: null, proxy_handle: 'h' });
    post({
      session_id: 's-1',
      tool_name: STATUS,
      tool_response: [{ type: 'text', text: unregistered }],
    });
    post({
      session_id: 's-1',
      tool_name: REGISTER,
      tool_response: [{ type: 'text', text: '{"error":{"code":"name_in_use"}}' }],
    });
    post({
      session_id: 's-1',
      tool_name: 'mcp__plugin_hive-wake_hive__read_mailbox',
      tool_response: [{ type: 'text', text: registeredText }],
    });
    post(
      {
        session_id: 's-1',
        tool_name: REGISTER,
        tool_response: [{ type: 'text', text: registeredText }],
      },
      { HIVE_HARNESS_SESSION: '/s.json' },
    );
    expect(existsSync(paths.sessionsDir(key))).toBe(false);
  });
});
