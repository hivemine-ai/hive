// Tests for the custom `no-cross-module-relative` ESLint rule (PRY-046).
// Run via `node --test eslint-rules/*.test.js` (Node 22+ built-in runner).

import { describe, test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';

import rule from './no-cross-module-relative.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// All tests share one synthetic package fixture under
// `__fixtures__/test-pkg/`. The fixture's `package.json` declares
// `#audit/*`, `#error/*`, `#transport/*`, `#domain/*` aliases — but
// NOT `#deep/*`, so we can exercise the missing-alias error path.
const FIXTURE_PKG = path.join(__dirname, '__fixtures__/test-pkg');

// Bridge ESLint's RuleTester (which calls describe/it globals from a
// test framework) into Node's native test runner — same shim as
// no-spanish-leakage.test.js.
RuleTester.describe = describe;
RuleTester.it = test;
RuleTester.itOnly = test.only;

// Use the TypeScript-ESLint parser so test fixtures can include
// TypeScript-specific syntax like `import type { … }`. The rule itself
// is parser-agnostic — it only inspects `node.source` — but tests
// must mirror real codebase syntax for credibility.
const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    ecmaVersion: 2022,
    sourceType: 'module',
  },
});

ruleTester.run('no-cross-module-relative', rule, {
  // ── valid: things the rule must NOT flag ─────────────────────────────
  valid: [
    {
      name: 'intra-module relative (./mappers.js) passes',
      filename: path.join(FIXTURE_PKG, 'src/audit/operator-actor.ts'),
      code: "import { foo } from './mappers.js';",
    },
    {
      // Whitelist: single-file parent import (no subdir hop). Resolves
      // to a sibling file, not a cross-module hop, so dual-module risk
      // is structurally impossible.
      name: 'whitelist parent single-file (../types.js) passes',
      filename: path.join(FIXTURE_PKG, 'src/audit/operator-actor.ts'),
      code: "import type { GlobalCliOpts } from '../types.js';",
    },
    {
      name: 'alias-canonical (#audit/...) passes',
      filename: path.join(FIXTURE_PKG, 'src/error/handler.ts'),
      code: "import { foo } from '#audit/operator-actor.js';",
    },
    {
      name: 'cross-package workspace name (@hive/server) passes',
      filename: path.join(FIXTURE_PKG, 'src/error/handler.ts'),
      code: "import { createDb } from '@hive/server';",
    },
    {
      name: 'node built-in (node:crypto) passes',
      filename: path.join(FIXTURE_PKG, 'src/audit/operator-actor.ts'),
      code: "import { createHash } from 'node:crypto';",
    },
    {
      // `'../../X/Y'` is already blocked by `no-restricted-imports`
      // per ADR-009 — the rule intentionally skips it to avoid
      // duplicate diagnostics on the same node.
      name: 'multi-level relative (../../persistence/db.js) passes',
      filename: path.join(FIXTURE_PKG, 'src/audit/sub/foo.ts'),
      code: "import { db } from '../../persistence/db.js';",
    },
    {
      // Inline disable directive should be respected by ESLint's
      // standard mechanism. RuleTester registers the rule as
      // `rule-to-test/<name>` internally; in production, the disable
      // comment uses `hive-local/no-cross-module-relative` instead.
      name: 'inline disable respected',
      filename: path.join(FIXTURE_PKG, 'src/error/handler.ts'),
      code: [
        '// eslint-disable-next-line rule-to-test/no-cross-module-relative -- justified for legacy compatibility',
        "import { foo } from '../audit/operator-actor.js';",
      ].join('\n'),
    },
  ],

  // ── invalid: things the rule MUST flag (with auto-fix when alias exists) ─
  invalid: [
    {
      name: 'cross-module single-segment with declared alias autofixes',
      filename: path.join(FIXTURE_PKG, 'src/error/handler.ts'),
      code: "import { foo } from '../audit/operator-actor.js';",
      output: "import { foo } from '#audit/operator-actor.js';",
      errors: [{ messageId: 'use-alias' }],
    },
    {
      name: 'cross-module multi-segment with top-level alias autofixes',
      filename: path.join(FIXTURE_PKG, 'src/composition/wire.ts'),
      code: "import { createMcpTransport } from '../transport/mcp/server.js';",
      output: "import { createMcpTransport } from '#transport/mcp/server.js';",
      errors: [{ messageId: 'use-alias' }],
    },
    {
      // Deep file (sibling submodule under domain/auth/) — auto-fix
      // must produce the FULL aliased path (`#domain/auth/keys/...`),
      // not the naive `#keys/...` (which would require declaring
      // `#keys/*` — wrong).
      name: 'deep cross-submodule resolves to top-level alias + remainder',
      filename: path.join(FIXTURE_PKG, 'src/domain/auth/credentials/verifier.ts'),
      code: "import type { SigningKey } from '../keys/keypair-store.js';",
      output: "import type { SigningKey } from '#domain/auth/keys/keypair-store.js';",
      errors: [{ messageId: 'use-alias' }],
    },
    {
      name: 'default import variant autofixes',
      filename: path.join(FIXTURE_PKG, 'src/error/handler.ts'),
      code: "import operatorActor from '../audit/operator-actor.js';",
      output: "import operatorActor from '#audit/operator-actor.js';",
      errors: [{ messageId: 'use-alias' }],
    },
    {
      name: 'namespace import variant autofixes',
      filename: path.join(FIXTURE_PKG, 'src/error/handler.ts'),
      code: "import * as audit from '../audit/operator-actor.js';",
      output: "import * as audit from '#audit/operator-actor.js';",
      errors: [{ messageId: 'use-alias' }],
    },
    {
      name: 'export-all re-export autofixes',
      filename: path.join(FIXTURE_PKG, 'src/error/handler.ts'),
      code: "export * from '../audit/operator-actor.js';",
      output: "export * from '#audit/operator-actor.js';",
      errors: [{ messageId: 'use-alias' }],
    },
    {
      name: 'export-named re-export autofixes',
      filename: path.join(FIXTURE_PKG, 'src/error/handler.ts'),
      code: "export { foo } from '../audit/operator-actor.js';",
      output: "export { foo } from '#audit/operator-actor.js';",
      errors: [{ messageId: 'use-alias' }],
    },
    {
      name: 'type-only import autofixes',
      filename: path.join(FIXTURE_PKG, 'src/error/handler.ts'),
      code: "import type { OperatorActor } from '../audit/operator-actor.js';",
      output: "import type { OperatorActor } from '#audit/operator-actor.js';",
      errors: [{ messageId: 'use-alias' }],
    },
    {
      // Quote style preservation: double-quoted source must produce
      // double-quoted output (Prettier normalises later, but ESLint's
      // fix should be idempotent on re-run with a different formatter).
      name: 'double-quote specifier preserves quote style',
      filename: path.join(FIXTURE_PKG, 'src/error/handler.ts'),
      code: 'import { foo } from "../audit/operator-actor.js";',
      output: 'import { foo } from "#audit/operator-actor.js";',
      errors: [{ messageId: 'use-alias' }],
    },
    {
      // Multiple cross-module imports in the same file: each one fires
      // independently, all auto-fixed in a single pass.
      name: 'multiple imports in one file each autofix',
      filename: path.join(FIXTURE_PKG, 'src/error/handler.ts'),
      code: [
        "import { foo } from '../audit/operator-actor.js';",
        "import { bar } from '../transport/mcp/server.js';",
      ].join('\n'),
      output: [
        "import { foo } from '#audit/operator-actor.js';",
        "import { bar } from '#transport/mcp/server.js';",
      ].join('\n'),
      errors: [{ messageId: 'use-alias' }, { messageId: 'use-alias' }],
    },
  ],
});

// ── invalid (missing-alias path, no auto-fix) ─────────────────────────
//
// The default RuleTester `output` semantics make the missing-alias
// case awkward to express in the same `invalid:` array (no fix
// expected, but the rule shouldn't be silent either). Use a separate
// runner for the no-fix path.
const ruleTesterNoFix = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    ecmaVersion: 2022,
    sourceType: 'module',
  },
});

ruleTesterNoFix.run('no-cross-module-relative — missing-alias path', rule, {
  valid: [],
  invalid: [
    {
      // Subdir `deep/` is not declared in fixture's `#imports`. Rule
      // emits `missing-alias` with the entry to add.
      name: 'cross-module to subdir without alias emits missing-alias error (no auto-fix)',
      filename: path.join(FIXTURE_PKG, 'src/error/handler.ts'),
      code: "import { foo } from '../deep/missing.js';",
      output: null,
      errors: [
        {
          messageId: 'missing-alias',
          data: {
            specifier: '../deep/missing.js',
            topSubdir: 'deep',
            pkgName: '@test/fixture-pkg',
          },
        },
      ],
    },
  ],
});
