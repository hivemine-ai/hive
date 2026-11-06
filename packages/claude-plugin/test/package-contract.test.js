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

  it('declares the mod and the command hooks in one hooks.json', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'hooks', 'hooks.json'), 'utf8'));
    expect(manifest.modules).toEqual(['./register.js']);
    expect(statSync(join(root, 'hooks', 'register.js')).isFile()).toBe(true);
    const start = manifest.hooks.SessionStart.flatMap((m) => m.hooks);
    expect(start.map((h) => h.command)).toEqual(['hivectl claude hook session-start']);
    const post = manifest.hooks.PostToolUse;
    expect(post).toHaveLength(1);
    const matcher = new RegExp(`^(?:${post[0].matcher})$`);
    expect(matcher.test('mcp__plugin_hive-wake_hive__register_session')).toBe(true);
    expect(matcher.test('mcp__plugin_hive-wake_hive__session_status')).toBe(true);
    expect(matcher.test('mcp__plugin_hive-wake_hive__send_message')).toBe(false);
    expect(post[0].hooks.map((h) => h.command)).toEqual(['hivectl claude hook post-tool-use']);
  });

  it('takes no user options: the URL and the credential live in the hivectl user state', () => {
    const plugin = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
    expect(plugin.userConfig).toBeUndefined();
    expect(plugin.name).toBe('hive-wake');
  });

  it('distributes files that exist, including the mod, the hooks and the skill', () => {
    const distribution = JSON.parse(readFileSync(join(root, 'distribution.json'), 'utf8'));
    for (const file of distribution.files) expect(statSync(join(root, file)).isFile()).toBe(true);
    expect(distribution.files).toEqual(
      expect.arrayContaining([
        'hooks/hooks.json',
        'hooks/register.js',
        'hooks/hivectl-path.js',
        'skills/hive-session/SKILL.md',
      ]),
    );
  });

  it('names the deferred plugin tools in the skill', () => {
    const skill = readFileSync(join(root, 'skills', 'hive-session', 'SKILL.md'), 'utf8');
    expect(skill).toMatch(/^---\nname: hive-session\n/);
    expect(skill).toContain('mcp__plugin_hive-wake_hive__register_session');
    expect(skill).toContain('ToolSearch');
    expect(skill).toContain('name_in_use');
    expect(skill).toContain('/mcp');
  });
});
