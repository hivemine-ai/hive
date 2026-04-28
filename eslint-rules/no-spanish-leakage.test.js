// Tests for the custom `no-spanish-leakage` ESLint rule (ADR-014, PRY-019).
// Run via `node --test eslint-rules/*.test.js` (Node 22+ built-in runner).

import { describe, test } from 'node:test';
import { RuleTester } from 'eslint';

import rule from './no-spanish-leakage.js';

// Bridge ESLint's RuleTester (which calls describe/it globals from a test
// framework) into Node's native test runner.
RuleTester.describe = describe;
RuleTester.it = test;
RuleTester.itOnly = test.only;

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
});

// RuleTester registers the rule under `rule-to-test/<name>` internally, so
// inline disable directives in test fixtures must use that prefix.
ruleTester.run('no-spanish-leakage', rule, {
  // ── valid: things the rule must NOT flag ─────────────────────────────
  valid: [
    {
      // Completely English comment.
      name: 'English comment passes',
      code: '// Open the cell store and write a message',
    },
    {
      // Stopword embedded inside an identifier — must NOT trigger because
      // the identifier is not a stand-alone word in the AST sense and the
      // rule does NOT scan identifiers (per ADR-014 § Decisión).
      name: 'stopword embedded in identifier passes',
      code: 'const cellPrivado = 1;',
    },
    {
      // Stopword as identifier on its own — also NOT scanned. Per ADR-014:
      // the rule scans comments + strings + template quasis only.
      name: 'stopword as bare identifier passes',
      code: 'const bloque = 1;',
    },
    {
      // English word that happens to contain a stopword as a substring
      // (`function` contains `función`? No — `function` and `función` differ
      // by accent. Check `validate` does not match `validar` — different
      // stems). The boundary check ensures we match only stand-alone words.
      name: 'English word sharing substring passes',
      code: 'function validateInput() { /* validate request */ }',
    },
    {
      // Inline disable directive — must be respected by ESLint's standard
      // mechanism. RuleTester internally registers the rule under
      // `rule-to-test/<name>`, hence that prefix in the disable comment.
      // In production code (eslint.config.js wires the plugin as
      // `hive-local`), the disable comment uses
      // `// eslint-disable-next-line hive-local/no-spanish-leakage` instead.
      name: 'inline disable respected',
      code: [
        '// eslint-disable-next-line rule-to-test/no-spanish-leakage',
        '// "Matriz de Visibilidad y Autorización" — vault spec name (legitimate citation)',
        'const x = 1;',
      ].join('\n'),
    },
    {
      // String literal that does NOT contain a stopword.
      name: 'English string literal passes',
      code: 'const msg = "operation completed successfully";',
    },
    {
      // Template literal with English-only static parts.
      name: 'English template literal passes',
      code: 'const greeting = `hello ${name}, welcome`;',
    },
  ],

  // ── invalid: things the rule MUST flag ───────────────────────────────
  invalid: [
    {
      name: 'Spanish word in line comment',
      code: '// Bloque de código',
      errors: [{ messageId: 'stopword', data: { word: 'Bloque' } }],
    },
    {
      name: 'Spanish word in block comment',
      code: '/* Esta función hace algo */',
      errors: [{ messageId: 'stopword', data: { word: 'función' } }],
    },
    {
      name: 'Spanish word in JSDoc',
      code: ['/**', ' * Implementa el patrón canónico.', ' */', 'function foo() {}'].join('\n'),
      errors: [{ messageId: 'stopword', data: { word: 'patrón' } }],
    },
    {
      name: 'Spanish word in string literal',
      code: 'const m = "el mensaje del usuario";',
      errors: [
        { messageId: 'stopword', data: { word: 'mensaje' } },
        { messageId: 'stopword', data: { word: 'usuario' } },
      ],
    },
    {
      name: 'Spanish word in template literal quasi',
      code: 'const m = `validar ${input} antes de continuar`;',
      errors: [{ messageId: 'stopword', data: { word: 'validar' } }],
    },
    {
      name: 'Multi-word stopword "una vez"',
      code: '// llamar una vez en construction',
      errors: [{ messageId: 'stopword', data: { word: 'una vez' } }],
    },
    {
      name: 'case-insensitive match — UPPERCASE',
      code: '// HITO 5 marcado',
      errors: [{ messageId: 'stopword', data: { word: 'HITO' } }],
    },
    {
      name: 'case-insensitive match — Capitalized',
      code: '// Hito 5 marcado',
      errors: [{ messageId: 'stopword', data: { word: 'Hito' } }],
    },
    {
      name: 'multiple stopwords in one comment',
      code: '// Bloque privado: la decisión es opcional',
      errors: [
        { messageId: 'stopword', data: { word: 'Bloque' } },
        { messageId: 'stopword', data: { word: 'privado' } },
        { messageId: 'stopword', data: { word: 'decisión' } },
        { messageId: 'stopword', data: { word: 'opcional' } },
      ],
    },
    {
      name: 'accented stopword "decisión"',
      code: '/* la decisión está documentada */',
      errors: [{ messageId: 'stopword', data: { word: 'decisión' } }],
    },
    {
      name: 'accented stopword "función"',
      code: '/* la función retorna null */',
      errors: [{ messageId: 'stopword', data: { word: 'función' } }],
    },
  ],
});
