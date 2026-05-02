// Post-bundle patch for SEA build.
//
// esbuild emits CJS bundles that replace `import.meta` with an empty object,
// which breaks `createRequire(import.meta.url)` calls in dependencies (e.g.
// `@hive/server`'s lazy `pg` resolver in `persistence/db.ts`). Patch the
// generated bundle so `import_meta.url` is initialized to the bundle's own
// file URL — sufficient for `createRequire` to resolve relative module
// specifiers inside the SEA at runtime.

import { readFileSync, writeFileSync } from 'node:fs';

const bundlePath = 'dist-sea/bundle.cjs';
const original = readFileSync(bundlePath, 'utf8');

const needle = 'var import_meta = {};';
const replacement =
  'var import_meta = { url: require("node:url").pathToFileURL(__filename).href };';

if (!original.includes(needle)) {
  console.error(`[sea:patch] expected pattern not found in ${bundlePath}: ${needle}`);
  process.exit(1);
}

// `replaceAll` is defensive — esbuild's CJS output emits a single top-level
// `import_meta` per bundle today, but the contract with esbuild's internal
// naming scheme is undocumented. Patching every occurrence keeps the script
// correct if a future bundler version emits more than one. The post-replace
// equality check then asserts the patch took effect (catches accidental
// no-ops if the needle ever drifts).
const patched = original.replaceAll(needle, replacement);
if (patched === original) {
  console.error(`[sea:patch] no replacement applied in ${bundlePath}`);
  process.exit(1);
}
writeFileSync(bundlePath, patched);
console.log(`[sea:patch] patched ${bundlePath}: import_meta.url initialized`);
