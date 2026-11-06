#!/usr/bin/env node
// Copies the hive-wake Claude Code plugin into `claude-plugin/` of this package
// before `npm pack` / `npm publish` (ADR-026: the plugin ships inside the npm
// wrapper, not inside the single-executable binaries). The files come from
// `packages/claude-plugin/distribution.json`, the same list `hivectl claude
// install` copies from.

const fs = require('node:fs');
const path = require('node:path');

const source = path.resolve(__dirname, '..', '..', 'packages', 'claude-plugin');
const target = path.join(__dirname, 'claude-plugin');
const distribution = JSON.parse(fs.readFileSync(path.join(source, 'distribution.json'), 'utf8'));

fs.rmSync(target, { recursive: true, force: true });
for (const file of ['distribution.json', ...distribution.files]) {
  const to = path.join(target, file);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(source, file), to);
}
process.stdout.write(
  `staged ${String(distribution.files.length + 1)} plugin files into ${target}\n`,
);
