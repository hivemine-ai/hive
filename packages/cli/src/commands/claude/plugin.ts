// The `hive-wake` plugin as `claude install` lays it out for Claude Code: a
// `directory` marketplace named `hive` under the user state
// (`<config>/marketplace/`), with the plugin in `plugins/hive-wake`. Claude Code
// runs the source of a directory marketplace in place (PRY-089), so this path
// must survive upgrades: it is a copy, rewritten on every install.
//
// The plugin ships inside the npm wrapper package (`@hivemine/hivectl`, folder
// `claude-plugin/`); in a checkout it is `packages/claude-plugin/`. Its
// `distribution.json` lists the files that make the installed plugin.

import { chmodSync, copyFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { ensurePrivateDir, writePrivateJson } from '#session/state-dir.js';

export const MARKETPLACE_NAME = 'hive';
export const PLUGIN_NAME = 'hive-wake';
const DISTRIBUTION = 'distribution.json';

export interface HivectlCommand {
  command: string;
  /** Arguments before the subcommand (the entry script when running from a checkout). */
  args: string[];
}

const requireFn = createRequire(import.meta.url);

function isSea(): boolean {
  try {
    return (requireFn('node:sea') as { isSea: () => boolean }).isSea();
  } catch {
    return false;
  }
}

/**
 * The absolute command that runs this very hivectl. The single executable when
 * running as one; otherwise node plus the entry script. It is never the npm
 * wrapper: the wrapper runs the binary as a child, so the proxy's parent would
 * be the wrapper instead of `claude` (breaking the PID map) and the signals
 * Claude Code sends would not reach the proxy.
 */
export function currentHivectlCommand(
  execPath = process.execPath,
  entry = process.argv[1],
  sea = isSea(),
): HivectlCommand {
  if (sea || entry === undefined) return { command: execPath, args: [] };
  return { command: execPath, args: [realpathSync(entry)] };
}

function hasDistribution(dir: string): boolean {
  return existsSync(join(dir, DISTRIBUTION)) && existsSync(join(dir, '.claude-plugin'));
}

/** Finds the plugin source next to this hivectl: npm wrapper package or checkout. */
export function findPluginSource(starts: string[]): string | undefined {
  for (const start of starts) {
    let dir = start;
    for (;;) {
      for (const candidate of [
        join(dir, 'claude-plugin'),
        join(dir, 'node_modules', '@hivemine', 'hivectl', 'claude-plugin'),
      ]) {
        if (hasDistribution(candidate)) return candidate;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return undefined;
}

export function defaultPluginSearchStarts(): string[] {
  const starts = [dirname(process.execPath)];
  const entry = process.argv[1];
  if (entry !== undefined) {
    try {
      starts.push(dirname(realpathSync(entry)));
    } catch {
      // A missing entry script only removes one search start.
    }
  }
  return starts;
}

export function marketplaceDir(configRoot: string): string {
  return join(configRoot, 'marketplace');
}

/** Writes (or rewrites in place) the marketplace and the plugin with the stdio server. */
export function installPluginCopy(
  source: string,
  configRoot: string,
  hivectl: HivectlCommand,
): string {
  const root = marketplaceDir(configRoot);
  const pluginDir = join(root, 'plugins', PLUGIN_NAME);
  const distribution = JSON.parse(readFileSync(join(source, DISTRIBUTION), 'utf8')) as {
    files: string[];
  };
  const manifest = JSON.parse(
    readFileSync(join(source, '.claude-plugin', 'plugin.json'), 'utf8'),
  ) as Record<string, unknown>;

  ensurePrivateDir(pluginDir);
  for (const file of distribution.files) {
    if (file === '.claude-plugin/plugin.json') continue;
    const target = join(pluginDir, file);
    ensurePrivateDir(dirname(target));
    copyFileSync(join(source, file), target);
    chmodSync(target, 0o600);
  }

  delete manifest['userConfig'];
  manifest['mcpServers'] = {
    hive: { command: hivectl.command, args: [...hivectl.args, 'mcp', 'proxy'] },
  };
  writePrivateJson(join(pluginDir, '.claude-plugin', 'plugin.json'), manifest);
  writePrivateJson(join(root, '.claude-plugin', 'marketplace.json'), {
    name: MARKETPLACE_NAME,
    owner: { name: 'Hivemine' },
    plugins: [
      {
        name: PLUGIN_NAME,
        source: `./plugins/${PLUGIN_NAME}`,
        description: typeof manifest['description'] === 'string' ? manifest['description'] : '',
      },
    ],
  });
  return root;
}
