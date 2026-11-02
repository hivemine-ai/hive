import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = new URL('..', import.meta.url).pathname;

function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'types') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else out.push(full);
  }
  return out;
}

describe('plugin contract', () => {
  const files = sourceFiles(root).filter((f) => !f.endsWith('.test.js'));

  it('never submits a prompt as the user', () => {
    const needle = ['asUser', ': ', 'true'].join('');
    const hits = files.filter((f) => readFileSync(f, 'utf8').includes(needle));
    expect(hits).toEqual([]);
  });

  it('never references the credential value, only its file path', () => {
    const hooks = files.filter((f) => f.includes('/hooks/') && f.endsWith('.js'));
    for (const f of hooks) {
      expect(readFileSync(f, 'utf8')).not.toMatch(/authorization|bearer/i);
    }
  });

  it('declares a hooks module that exists', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'hooks', 'hooks.json'), 'utf8'));
    expect(manifest.modules).toEqual(['./register.js']);
    expect(statSync(join(root, 'hooks', 'register.js')).isFile()).toBe(true);
  });

  it('declares the three user options', () => {
    const plugin = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
    expect(Object.keys(plugin.userConfig)).toEqual([
      'server_url',
      'credential_file',
      'hivectl_path',
    ]);
  });
});
