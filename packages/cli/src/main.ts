#!/usr/bin/env node
// hivectl entry point. Parses argv via commander; closes the runtime in
// `finally` so the DB pool exits cleanly. The lazy runtime keeps `--help`
// and `--version` from touching Postgres.

import { initColorMode } from './output/colors.js';
import { buildProgram, closeRuntime } from './program.js';

async function main(argv: string[]): Promise<number> {
  // Apply NO_COLOR / --no-color before commander parses, so that
  // `--version`, `--help`, and any parse-time errors are also rendered
  // without ANSI sequences when the operator opted out of colour.
  initColorMode({ argv, env: process.env });
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
