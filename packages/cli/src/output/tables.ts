// Minimal table renderer for `--output table`. Supports columns + alignment +
// max-width truncation with `…` ellipsis. ~100 LoC; no `cli-table3` dep.

export type ColumnAlign = 'left' | 'right';

export interface TableColumn<T> {
  /** Header label rendered in the title row. */
  header: string;
  /** Field accessor — supports nested via `(row) => ...`. */
  accessor: (row: T) => unknown;
  /** Default 'left'. */
  align?: ColumnAlign;
  /** Truncate to this width (in chars) with '…' suffix. Default 64. */
  maxWidth?: number;
  /** Custom formatter for the cell value. Default: stringify ISO for Date, String() otherwise. */
  format?: (value: unknown) => string;
}

export type TableSchema<T> = TableColumn<T>[];

const DEFAULT_MAX_WIDTH = 64;
const ELLIPSIS = '…';

/**
 * Render `data` (single record OR array of records) per the schema. Empty
 * input returns the schema-aware "(no rows)" sentinel so the operator
 * still sees the column headers.
 */
export function renderTable<T>(data: T | T[], schema: TableSchema<T>): string {
  const rows = Array.isArray(data) ? data : [data];
  const formatted: string[][] = rows.map((row) =>
    schema.map((col) => formatCell(col, col.accessor(row))),
  );

  const widths = schema.map((col, idx) => {
    const headerWidth = col.header.length;
    const cellWidth = formatted.reduce((acc, cells) => {
      const cell = cells[idx] ?? '';
      return Math.max(acc, cell.length);
    }, 0);
    return Math.max(headerWidth, cellWidth);
  });

  const separator = widths.map((w) => '-'.repeat(w)).join('  ');
  const header = schema
    .map((col, idx) => padCell(col.header, widths[idx] ?? 0, col.align ?? 'left'))
    .join('  ');
  const lines = [header, separator];
  if (formatted.length === 0) {
    lines.push('(no rows)');
    return lines.join('\n');
  }
  for (const cells of formatted) {
    lines.push(
      cells
        .map((cell, idx) => padCell(cell, widths[idx] ?? 0, schema[idx]?.align ?? 'left'))
        .join('  '),
    );
  }
  return lines.join('\n');
}

function formatCell<T>(col: TableColumn<T>, value: unknown): string {
  const raw = col.format ? col.format(value) : defaultFormat(value);
  const max = col.maxWidth ?? DEFAULT_MAX_WIDTH;
  if (raw.length <= max) return raw;
  return raw.slice(0, max - ELLIPSIS.length) + ELLIPSIS;
}

function defaultFormat(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((x) => defaultFormat(x)).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return JSON.stringify(value);
}

function padCell(value: string, width: number, align: ColumnAlign): string {
  if (value.length >= width) return value;
  const padding = ' '.repeat(width - value.length);
  return align === 'right' ? padding + value : value + padding;
}
