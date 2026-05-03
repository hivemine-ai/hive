#!/usr/bin/env node
// hivectl entry point. Two paths from here:
//   (1) bare `hivectl` (no subcommand, no flags) → cold-start handler
//       reads the local status snapshot and renders banner + status +
//       try block (per [[hivectl — Operator Experience]] § Cold start).
//       The commander tree never loads in this branch — that is what
//       keeps the AC of <50ms warm achievable on a fresh install (no
//       handlers, no DB, no schema modules).
//   (2) anything else → load the commander tree, dispatch, close the
//       lazy runtime in `finally` so the DB pool exits cleanly.

import { initColorMode } from './output/colors.js';

async function main(argv: string[]): Promise<number> {
  // NO_COLOR / --no-color applied first so cold-start, --version,
  // --help, and any parse-time errors all honour the operator's
  // colour preference.
  initColorMode({ argv, env: process.env });

  // Fast path: `argv = [node, hivectl]` exactly → cold start. Anything
  // longer (subcommand, flag, --help, --version, unknown token) goes
  // through commander.
  if (argv.length === 2) {
    const { runColdStart } = await import('./commands/cold-start.js');
    await runColdStart();
    return 0;
  }

  const { buildProgram, closeRuntime } = await import('./program.js');
  const { program, getExitCode } = buildProgram();
  try {
    await program.parseAsync(argv);
    return getExitCode();
  } finally {
    try {
      await closeRuntime();
    } catch {
      // Swallow runtime teardown errors — the operator already saw the result.
    }
  }
}

main(process.argv).then(
  (code) => {
    process.exit(code);
  },
  (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`fatal: ${msg}\n`);
    process.exit(2);
  },
);
