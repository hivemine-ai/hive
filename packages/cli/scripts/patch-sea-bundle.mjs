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

const patched = original.replace(needle, replacement);
writeFileSync(bundlePath, patched);
console.log(`[sea:patch] patched ${bundlePath}: import_meta.url initialized`);
