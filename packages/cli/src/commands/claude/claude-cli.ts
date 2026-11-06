// The official `claude` CLI, run with argv directly (no shell) and the project as
// working directory, so `--scope local` lands in that project.

import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

/** Claude Code version validated by the PRY-089 spike. */
export const VALIDATED_CLAUDE_VERSION = [2, 1, 318] as const;

export function findOnPath(binary: string, path: string | undefined): string | undefined {
  for (const dir of (path ?? '').split(delimiter)) {
    if (dir === '' || !isAbsolute(dir)) continue;
    const candidate = join(dir, binary);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here.
    }
  }
  return undefined;
}

export interface ClaudeRun {
  code: number;
  stdout: string;
  stderr: string;
}

export function runClaude(
  claude: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<ClaudeRun> {
  return new Promise((resolve) => {
    execFile(claude, args, { cwd, env, timeout: 120_000 }, (err, stdout, stderr) => {
      const code = err === null ? 0 : typeof err.code === 'number' ? err.code : 1;
      resolve({ code, stdout, stderr });
    });
  });
}

/** True when `version` (as `claude --version` prints it) is older than the validated one. */
export function isOlderThanValidated(version: string): boolean | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match === null) return undefined;
  const parts = match.slice(1, 4).map(Number);
  for (let i = 0; i < 3; i += 1) {
    const have = parts[i] ?? 0;
    const want = VALIDATED_CLAUDE_VERSION[i] ?? 0;
    if (have !== want) return have < want;
  }
  return false;
}
