// Singleton lazy `CliRuntime`. The first command that needs Postgres + the
// signing keys triggers `wire.startCli()`. `--help`, `--version`, parse-only
// commands never touch it. The `closeRuntime()` is invoked from `main.ts`
// in `finally` so the DB pool exits cleanly.

import { startCli, stopCli } from '@hive/server';
import type { CliRuntime, Logger } from '@hive/server';

let cache: CliRuntime | null = null;

export async function getRuntime(logger: Logger): Promise<CliRuntime> {
  if (cache) return cache;
  cache = await startCli({ logger });
  return cache;
}

export async function closeRuntime(): Promise<void> {
  if (!cache) return;
  await stopCli(cache);
  cache = null;
}

/** Test-only: drop the cache without touching the DB. */
export function __resetRuntimeForTests(): void {
  cache = null;
}
