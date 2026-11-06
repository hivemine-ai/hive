// The npm wrapper `@hivemine/hivectl` carries the plugin (ADR-026): staging copies
// the files of distribution.json into npm/hivectl/claude-plugin/ and `npm pack`
// includes them.

import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const root = new URL('..', import.meta.url).pathname;
const wrapper = join(root, '..', '..', 'npm', 'hivectl');

afterAll(() => {
  rmSync(join(wrapper, 'claude-plugin'), { recursive: true, force: true });
});

describe('npm wrapper package', () => {
  it('includes the staged plugin files in its tarball', () => {
    execFileSync(process.execPath, [join(wrapper, 'stage-plugin.js')], { stdio: 'ignore' });
    const packed = JSON.parse(
      execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
        cwd: wrapper,
        encoding: 'utf8',
      }),
    );
    const files = packed[0].files.map((f) => f.path);
    const distribution = JSON.parse(readFileSync(join(root, 'distribution.json'), 'utf8'));

    expect(files).toContain('claude-plugin/distribution.json');
    for (const file of distribution.files) expect(files).toContain(`claude-plugin/${file}`);
    expect(files).not.toContain('stage-plugin.js');
  });

  it('distributes a manifest named hive-wake', () => {
    const distribution = JSON.parse(readFileSync(join(root, 'distribution.json'), 'utf8'));
    expect(distribution.files).toContain('.claude-plugin/plugin.json');
    const manifest = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
    expect(manifest.name).toBe('hive-wake');
  });
});
