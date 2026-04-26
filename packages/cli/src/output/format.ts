// Output formatter. Resolves output mode (auto = table if TTY else json),
// serializes data via JSON / YAML / table per the tech spec.

import { stringify as yamlStringify } from 'yaml';

import { renderTable } from './tables.js';
import type { TableSchema } from './tables.js';
import type { OutputMode } from '../types.js';

export interface FormatContext<T> {
  mode: OutputMode;
  schema: TableSchema<T>;
}

/**
 * Resolve the runtime output mode. The flag wins; otherwise the env var
 * `HIVE_CLI_DEFAULT_OUTPUT` (auto/table/json/yaml); otherwise auto-detect via
 * `process.stdout.isTTY`.
 */
export function resolveOutputMode(
  flag: string | undefined,
  isTty: boolean,
  envValue: string | undefined = process.env['HIVE_CLI_DEFAULT_OUTPUT'],
): OutputMode {
  if (flag) return validateMode(flag);
  if (envValue && envValue !== 'auto') return validateMode(envValue);
  return isTty ? 'table' : 'json';
}

function validateMode(input: string): OutputMode {
  if (input === 'table' || input === 'json' || input === 'yaml') return input;
  throw new Error(`invalid output mode '${input}'; expected one of: table, json, yaml`);
}

/** Replacer that serializes Date as ISO 8601 UTC string (consistent with MCP wire). */
export function dateReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  return value;
}

/**
 * Format a single record (object) for the target mode.
 *
 * - `table`: render via the provided schema.
 * - `json`: pretty-print with 2-space indent.
 * - `yaml`: serialize via the `yaml` package.
 */
export function formatOutput<T>(data: T, ctx: FormatContext<T>): string {
  switch (ctx.mode) {
    case 'json':
      return JSON.stringify(data, dateReplacer, 2);
    case 'yaml':
      return yamlStringify(data, { indent: 2 });
    case 'table':
      return renderTable(data, ctx.schema);
    default: {
      const exhaustive: never = ctx.mode;
      throw new Error(`unsupported output mode: ${String(exhaustive)}`);
    }
  }
}

/**
 * Format a list of records. Same modes as `formatOutput`; for `table`, each row
 * is rendered as a row in the schema.
 */
export function formatOutputList<T>(data: T[], ctx: FormatContext<T>): string {
  switch (ctx.mode) {
    case 'json':
      return JSON.stringify(data, dateReplacer, 2);
    case 'yaml':
      return yamlStringify(data, { indent: 2 });
    case 'table':
      return renderTable(data, ctx.schema);
    default: {
      const exhaustive: never = ctx.mode;
      throw new Error(`unsupported output mode: ${String(exhaustive)}`);
    }
  }
}
