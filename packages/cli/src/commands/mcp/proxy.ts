// `hivectl mcp proxy`: the stdio MCP server that Claude Code launches once per
// session (ADR-026). A local client: no database, no runtime. stdout carries
// only the MCP protocol; diagnostics go to stderr as JSON lines.
//
// It ends on stdin EOF (Claude Code is gone, even after a kill -9), SIGINT
// (`/exit`), SIGTERM (end of `claude -p`) and SIGHUP; on any of them it closes
// the stream, so the session goes offline without waiting for the lease. It
// never exits for anything else: exceptions are logged and swallowed, because
// Claude Code does not relaunch a dead stdio server.

import { homedir } from 'node:os';

import type { Command } from 'commander';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { startProxy } from '#session/proxy.js';

const END_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

function logLine(event: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  try {
    process.stderr.write(
      `${JSON.stringify({ ts: new Date().toISOString(), level: 'error', event, message })}\n`,
    );
  } catch {
    // stderr may be gone; there is nobody left to tell.
  }
}

export async function runMcpProxy(): Promise<number> {
  const onException = (err: unknown): void => logLine('proxy.uncaught_exception', err);
  const onRejection = (err: unknown): void => logLine('proxy.unhandled_rejection', err);
  process.on('uncaughtException', onException);
  process.on('unhandledRejection', onRejection);

  const proxy = startProxy({
    env: process.env,
    cwd: process.cwd(),
    home: homedir(),
    claudePid: process.ppid,
    stderr: (text) => void process.stderr.write(text),
    transport: new StdioServerTransport(process.stdin, process.stdout),
  });
  const onSignal = (signal: NodeJS.Signals): void => {
    void proxy.shutdown(signal);
  };
  for (const signal of END_SIGNALS) process.on(signal, onSignal);
  await proxy.closed;
  for (const signal of END_SIGNALS) process.off(signal, onSignal);
  return 0;
}

export function registerMcpCommand(
  program: Command,
  hooks: { setExitCode(code: number): void },
): void {
  const mcp = program.command('mcp').description('Local MCP endpoints for Claude Code sessions.');
  mcp
    .command('proxy')
    .description(
      'Stdio MCP server for one Claude Code session: registers the session in Hive and ' +
        'forwards its tools. Launched by the hive-wake plugin, not by hand.',
    )
    .action(async () => {
      hooks.setExitCode(await runMcpProxy());
    });
}
