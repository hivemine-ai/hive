import { describe, expect, it } from 'vitest';

import { formatOutput, formatOutputList, resolveOutputMode } from './format.js';
import type { TableSchema } from './tables.js';

interface Sample {
  id: string;
  name: string;
  count: number;
  createdAt: Date;
}

const sampleSchema: TableSchema<Sample> = [
  { header: 'id', accessor: (r) => r.id },
  { header: 'name', accessor: (r) => r.name },
  { header: 'count', accessor: (r) => r.count, align: 'right' },
  { header: 'createdAt', accessor: (r) => r.createdAt },
];

const sample: Sample = {
  id: '019d57a0-d6e0-7b3a-8d4f-cb2c4e72d100',
  name: 'Worker A',
  count: 42,
  createdAt: new Date('2026-04-26T20:00:00Z'),
};

describe('resolveOutputMode', () => {
  it('honors explicit flag', () => {
    expect(resolveOutputMode('json', true)).toBe('json');
    expect(resolveOutputMode('table', false)).toBe('table');
    expect(resolveOutputMode('yaml', true)).toBe('yaml');
  });

  it('defaults to table when TTY and no flag/env', () => {
    expect(resolveOutputMode(undefined, true, undefined)).toBe('table');
  });

  it('defaults to json when not TTY and no flag/env', () => {
    expect(resolveOutputMode(undefined, false, undefined)).toBe('json');
  });

  it('uses HIVE_CLI_DEFAULT_OUTPUT env when set (non-auto)', () => {
    expect(resolveOutputMode(undefined, true, 'yaml')).toBe('yaml');
    expect(resolveOutputMode(undefined, false, 'table')).toBe('table');
  });

  it('treats HIVE_CLI_DEFAULT_OUTPUT=auto as no override', () => {
    expect(resolveOutputMode(undefined, true, 'auto')).toBe('table');
    expect(resolveOutputMode(undefined, false, 'auto')).toBe('json');
  });

  it('rejects invalid mode', () => {
    expect(() => resolveOutputMode('invalid', true)).toThrow(/invalid output mode/);
  });
});

describe('formatOutput (single record)', () => {
  it('json emits parseable output with Date as ISO', () => {
    const out = formatOutput(sample, { mode: 'json', schema: sampleSchema });
    const parsed = JSON.parse(out) as Sample;
    expect(parsed.id).toBe(sample.id);
    expect(parsed.count).toBe(42);
    expect(parsed.createdAt).toBe('2026-04-26T20:00:00.000Z');
  });

  it('yaml emits valid YAML', () => {
    const out = formatOutput(sample, { mode: 'yaml', schema: sampleSchema });
    expect(out).toMatch(/^id:\s/m);
    expect(out).toMatch(/name:\s/);
    expect(out).toMatch(/count: 42/);
  });

  it('table emits header + separator + row', () => {
    const out = formatOutput(sample, { mode: 'table', schema: sampleSchema });
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/^id\s+name\s+count\s+createdAt/);
    expect(lines[1]).toMatch(/^-+\s+-+\s+-+\s+-+/);
    expect(lines[2]).toMatch(/Worker A/);
    expect(lines[2]).toMatch(/42/);
  });
});

describe('formatOutputList (array)', () => {
  it('json emits array', () => {
    const out = formatOutputList([sample, sample], { mode: 'json', schema: sampleSchema });
    const parsed = JSON.parse(out) as Sample[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);
  });

  it('yaml emits sequence', () => {
    const out = formatOutputList([sample], { mode: 'yaml', schema: sampleSchema });
    expect(out).toMatch(/^- /m);
  });

  it('table renders multiple rows', () => {
    const out = formatOutputList([sample, { ...sample, name: 'Worker B', count: 7 }], {
      mode: 'table',
      schema: sampleSchema,
    });
    expect(out).toMatch(/Worker A/);
    expect(out).toMatch(/Worker B/);
  });

  it('table shows "(no rows)" sentinel for empty list', () => {
    const out = formatOutputList([], { mode: 'table', schema: sampleSchema });
    expect(out).toMatch(/\(no rows\)/);
  });
});
