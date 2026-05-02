// Post-bundle patch for SEA build.
//
// esbuild emits CJS bundles that replace `import.meta` with an empty object,
// which breaks `createRequire(import.meta.url)` calls in source modules
// (e.g. `@hive/server`'s lazy `pg` resolver in `persistence/db.ts`,
// `observability/logger.ts`'s `node:sea` detector for INC-2026-004).
// Patch the generated bundle so every `import_meta*.url` is initialized to
// the bundle's own file URL — sufficient for `createRequire` to resolve
// module specifiers inside the SEA at runtime.

import { readFileSync, writeFileSync } from 'node:fs';

const bundlePath = 'dist-sea/bundle.cjs';
const original = readFileSync(bundlePath, 'utf8');

// esbuild auto-suffixes the variable name when more than one source module
// references `import.meta` (`import_meta`, `import_meta2`, `import_meta3`,
// ...). The capture group lets the replacement preserve each suffix so the
// downstream `import_metaN.url` access lands on the patched object.
const pattern = /var (import_meta\d*) = \{\};/g;
const matches = [...original.matchAll(pattern)];

if (matches.length === 0) {
  console.error(`[sea:patch] expected pattern not found in ${bundlePath}: ${pattern}`);
  process.exit(1);
}

const patched = original.replace(
  pattern,
  (_match, name) => `var ${name} = { url: require("node:url").pathToFileURL(__filename).href };`,
);

if (patched === original) {
  console.error(`[sea:patch] no replacement applied in ${bundlePath}`);
  process.exit(1);
}

writeFileSync(bundlePath, patched);
console.log(
  `[sea:patch] patched ${bundlePath}: ${matches.length} import_meta* occurrence(s) initialized`,
);
