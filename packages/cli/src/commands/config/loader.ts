// Persistent config consumed by `hivectl serve` boot.
//
// `hivectl config network` writes to this file. `serve` reads it on boot to
// resolve the bind address with precedence: --host flag > HIVE_MCP_HTTP_HOST
// env > config.json httpHost > default `127.0.0.1`.
//
// Pure I/O helpers — no network, no spawn.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface PersistedConfig {
  /** Bind address persisted by `hivectl config network`. */
  httpHost?: string;
}

/**
 * Reads `config.json` from `path`. Returns `null` if the file doesn't exist.
 * Throws on JSON parse failure (the operator should see a clear error rather
 * than silently fall back to defaults — a corrupt config file is a bug).
 */
export function readConfigFile(filePath: string): PersistedConfig | null {
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, 'utf8');
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`expected JSON object, got ${typeof parsed}`);
    }
    return parsed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid config file at ${filePath}: ${msg}`);
  }
}

/**
 * Writes `config` atomically: write to `<file>.tmp` then rename to `<file>`.
 * Creates the parent directory tree if missing. Idempotent — overwrites.
 */
export function writeConfigFile(filePath: string, config: PersistedConfig): void {
  const dir = path.dirname(filePath);
  // mkdirSync recursive=true is idempotent — no `existsSync` race needed.
  mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  renameSync(tmpPath, filePath);
}

/**
 * Resolves the bind address with precedence: flag > env > config file > default.
 *
 * Default is `127.0.0.1` (local-only) — closes INC-2026-001 FLAG-005 by
 * default; the operator opts into LAN exposure via `hivectl config network
 * bind-all` (which writes `0.0.0.0` to the config file and also prints a
 * warning).
 */
export function resolveHttpHost(input: {
  flag: string | undefined;
  env: string | undefined;
  configFile: PersistedConfig | null;
}): string {
  if (input.flag !== undefined) return input.flag;
  if (input.env !== undefined && input.env !== '') return input.env;
  if (input.configFile?.httpHost !== undefined) return input.configFile.httpHost;
  return '127.0.0.1';
}
