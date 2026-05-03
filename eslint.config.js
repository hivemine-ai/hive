import js from '@eslint/js';
import tseslint from 'typescript-eslint';

import noCrossModuleRelative from './eslint-rules/no-cross-module-relative.js';
import noSpanishLeakage from './eslint-rules/no-spanish-leakage.js';

// Local plugin bundle. Houses repo-specific rules. Add new rules here
// as they are authored in `eslint-rules/`.
const hiveLocal = {
  rules: {
    'no-cross-module-relative': noCrossModuleRelative,
    'no-spanish-leakage': noSpanishLeakage,
  },
};

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  // Cross-module relative imports are blocked inside package source per ADR-009.
  // Use the package `imports` field aliases (#persistence/*, #domain/*, etc.) instead.
  // Scoped to packages/*/src/** so root config files (eslint.config.js, etc.) are not flagged.
  // The Spanish-leakage guard (ADR-014) shares the same scope — only repo
  // source code is enforced; tests, configs, and the vault are not.
  {
    files: ['packages/*/src/**/*.{ts,tsx}'],
    plugins: {
      'hive-local': hiveLocal,
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../../*', '../../../*', '../../../../*'],
              message:
                'Use the package "imports" alias (#persistence/*, #domain/*, etc.) instead of relative cross-module imports. See ADR-009.',
            },
          ],
        },
      ],
      // Spanish-leakage guard per ADR-014 — fails on any stopword from
      // eslint-rules/spanish-stopwords.json appearing inside comments,
      // string literals, or template literal quasis. Override per-line
      // with `// eslint-disable-next-line hive-local/no-spanish-leakage`
      // when the case is legitimate (eg. textually quoted vault spec name).
      'hive-local/no-spanish-leakage': 'error',
      // Cross-module relative import guard per PRY-046. The built-in
      // `no-restricted-imports` above blocks `'../../...'` (2+ levels)
      // but permits `'../subdir/file.js'` (single-level cross-module),
      // which leaves the dual-module bundling pitfall open: when the
      // same file is imported via mixed specifier styles (relative +
      // alias) across the package, esbuild bundles it twice and
      // `instanceof` fails cross-boundary in the SEA output. This
      // custom rule closes the gap with auto-fix when the matching
      // `#alias/*` is declared, and emits a self-explanatory error
      // (with the exact entry to add to `package.json#imports`) when
      // it isn't. See ADR-009 + lessons-pry §Tooling (PRY-040, PRY-045).
      'hive-local/no-cross-module-relative': 'error',
    },
  },
);
