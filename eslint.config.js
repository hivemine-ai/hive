import js from '@eslint/js';
import tseslint from 'typescript-eslint';

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
  {
    files: ['packages/*/src/**/*.{ts,tsx}'],
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
    },
  },
);
