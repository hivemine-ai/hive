import js from '@eslint/js';
import tseslint from 'typescript-eslint';

import noSpanishLeakage from './eslint-rules/no-spanish-leakage.js';

// Local plugin bundle. Houses repo-specific rules — currently only the
// Spanish-leakage guard (per ADR-014). Add new rules here as they are
// authored in `eslint-rules/`.
const hiveLocal = {
  rules: {
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
    },
  },
);
