// Custom ESLint rule: no-cross-module-relative.
//
// Disallows cross-module relative imports inside packages/*/src/**.
// "Cross-module" means: a relative specifier that starts with `..` and
// crosses into a sibling subdirectory (e.g. `'../audit/foo.js'`,
// `'../transport/mcp/server.js'`). Single-level same-directory imports
// (`'./mappers.js'`) and single-file parent imports (`'../types.js'`,
// no subdir hop) are intentionally allowed.
//
// Why: when the same module is imported via mixed specifier styles
// across the package source — once via relative `'../subdir/file.js'`
// and once via the alias `'#subdir/file.js'` — esbuild bundles the
// module TWICE in the SEA output (`var X` + `var X2`), and any
// `instanceof X` cross-boundary fails (returns false). This bug is
// invisible in `pnpm test` (vitest dedupes via Node's ESM resolver) and
// only manifests in the SEA bundle. Standardising every cross-module
// import on the alias-canonical form removes the ambiguity. See
// ADR-009 (Aliases internos) + lessons-pry.md §Tooling (PRY-040,
// PRY-045) for the historical incidents.
//
// The rule has an auto-fix: when the matching alias `#subdir/*` IS
// declared in the package's `package.json#imports`, it rewrites the
// specifier in place (`pnpm lint --fix`). When the alias is NOT
// declared, it emits an error with the exact entry the developer must
// add to `package.json#imports` (mechanical convention, no ADR
// needed). Re-running `pnpm lint --fix` after adding the alias
// completes the migration.

import fs from 'node:fs';
import path from 'node:path';

// Cache resolved package config keyed by package root, so we read each
// `package.json` at most once per process. ESLint reuses the rule
// instance across files in a single run.
/** @type {Map<string, { srcDir: string; pkgName: string; aliases: Array<{ prefix: string; targetSrcDir: string }> }>} */
const PACKAGE_CACHE = new Map();

/**
 * Walk up from `dir` to the nearest `package.json`. Returns the parsed
 * package config (with aliases mapped from `dist/` to `src/`), or
 * `null` if no package boundary is found before the filesystem root.
 *
 * Stops at the FIRST `package.json` found, regardless of whether it
 * declares an `imports` field. The package boundary (the file's owning
 * package) is the one that matters; if it has no aliases, the rule
 * still emits a helpful error pointing the developer at the missing
 * entry.
 *
 * @param {string} dir
 * @returns {{ root: string; srcDir: string; pkgName: string; aliases: Array<{ prefix: string; targetSrcDir: string }> } | null}
 */
function findPackage(dir) {
  let current = dir;
  while (true) {
    const pkgPath = path.join(current, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const cached = PACKAGE_CACHE.get(current);
      if (cached) return { root: current, ...cached };
      let pkg;
      try {
        pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      } catch {
        return null;
      }
      const aliases = [];
      if (pkg && pkg.imports && typeof pkg.imports === 'object') {
        for (const [aliasKey, target] of Object.entries(pkg.imports)) {
          if (typeof target !== 'string') continue;
          // Only directory aliases (`#X/*` → `./dist/X/*`) participate
          // in the cross-module rewriter. File-specific aliases like
          // `#types.js` → `./dist/types.js` are skipped: the matching
          // import (`'../types.js'`) is already in the whitelist.
          if (!aliasKey.endsWith('/*') || !target.endsWith('/*')) continue;
          const prefix = aliasKey.slice(0, -2); // `#audit/*` → `#audit`
          const targetTrimmed = target.slice(0, -2); // `./dist/audit/*` → `./dist/audit`
          // Map `dist` → `src` for source-time matching. Tolerant of
          // both `./dist/X` and `dist/X` forms.
          const targetSrc = targetTrimmed
            .replace(/^\.\/dist(\/|$)/, './src$1')
            .replace(/^dist(\/|$)/, 'src$1');
          const targetSrcAbs = path.resolve(current, targetSrc);
          aliases.push({ prefix, targetSrcDir: targetSrcAbs });
        }
        // Sort longest-target-first so the most specific alias wins on
        // overlap (e.g. if both `#domain/*` and `#domain/auth/*` were
        // declared, the latter should match first).
        aliases.sort((a, b) => b.targetSrcDir.length - a.targetSrcDir.length);
      }
      const srcDir = path.join(current, 'src');
      const pkgName = (pkg && typeof pkg.name === 'string' && pkg.name) || path.basename(current);
      const result = { srcDir, pkgName, aliases };
      PACKAGE_CACHE.set(current, result);
      return { root: current, ...result };
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    fixable: 'code',
    docs: {
      description:
        'Disallow cross-module relative imports inside packages/*/src — use #alias/* declared in package.json#imports instead. Prevents the dual-module bundling pitfall (ADR-009, lessons-pry §Tooling: PRY-040, PRY-045).',
    },
    schema: [],
    messages: {
      'use-alias':
        "Cross-module relative import '{{specifier}}' detected. Use '{{suggested}}' instead — same module, alias-canonical specifier (prevents dual-module bundling per ADR-009 + lessons-pry §Tooling). Run `pnpm lint --fix` to auto-migrate.",
      'missing-alias':
        'Cross-module relative import \'{{specifier}}\' detected. The canonical alias \'#{{topSubdir}}/*\' is not declared in {{pkgName}}/package.json#imports.\n\nAdd this entry (mechanical convention per ADR-009):\n\n  "#{{topSubdir}}/*": "./dist/{{topSubdir}}/*"\n\nThen re-run `pnpm lint --fix` to migrate this import automatically.',
    },
  },

  create(context) {
    const filename = context.filename;
    const fileDir = path.dirname(filename);

    /**
     * @param {import('estree').ImportDeclaration | import('estree').ExportNamedDeclaration | import('estree').ExportAllDeclaration} node
     */
    function check(node) {
      const source = node.source;
      if (!source || typeof source.value !== 'string') return;
      const specifier = source.value;
      // Only single-level parent-relative specifiers. `'../../...'` is
      // already blocked by `no-restricted-imports` per ADR-009 — we
      // intentionally skip those to avoid duplicate diagnostics.
      if (!specifier.startsWith('../') || specifier.startsWith('../../')) return;
      // Whitelist single-file parent imports: `'../<file>'` (no subdir
      // hop). E.g. `'../types.js'`. Per ADR-009 these don't cross a
      // module boundary, so they don't risk dual-module bundling.
      if (/^\.\.\/[^/]+$/.test(specifier)) return;

      const pkg = findPackage(fileDir);
      if (!pkg) return;

      const resolvedAbs = path.resolve(fileDir, specifier);
      // Bail if the resolved target escapes the package's src dir
      // (e.g. cross-package — not our concern; that should use the
      // workspace package name like `@hive/server`).
      const relFromSrc = path.relative(pkg.srcDir, resolvedAbs);
      if (relFromSrc.startsWith('..') || path.isAbsolute(relFromSrc)) return;
      const topSubdir = relFromSrc.split(path.sep)[0];

      // Find the most specific alias whose target dir is an ancestor
      // of the resolved import path.
      let bestMatch = null;
      for (const alias of pkg.aliases) {
        if (
          resolvedAbs === alias.targetSrcDir ||
          resolvedAbs.startsWith(alias.targetSrcDir + path.sep)
        ) {
          bestMatch = alias;
          break; // sorted longest-first, first hit is the best
        }
      }

      if (bestMatch) {
        const remainder = path.relative(bestMatch.targetSrcDir, resolvedAbs);
        // Render the suggestion using POSIX separators — import
        // specifiers are POSIX regardless of host OS.
        const suggested = remainder
          ? `${bestMatch.prefix}/${remainder.split(path.sep).join('/')}`
          : bestMatch.prefix;
        context.report({
          node: source,
          messageId: 'use-alias',
          data: { specifier, suggested },
          fix(fixer) {
            // Preserve original quote style (single vs double) by
            // reading the first char of the raw source.
            const raw = source.raw || `'${specifier}'`;
            const quote = raw[0];
            return fixer.replaceText(source, `${quote}${suggested}${quote}`);
          },
        });
      } else {
        context.report({
          node: source,
          messageId: 'missing-alias',
          data: { specifier, topSubdir, pkgName: pkg.pkgName },
        });
      }
    }

    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
    };
  },
};

export default rule;
