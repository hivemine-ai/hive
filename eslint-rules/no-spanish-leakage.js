// Custom ESLint rule: no-spanish-leakage.
//
// Enforces CLAUDE.md regla #3 + ADR-014: code inside `repositories/hive/`
// must be in English. Matches a configurable list of Spanish stopwords
// (case-insensitive, word-bounded) inside:
//   - Line and block comments (including JSDoc).
//   - String literals.
//   - Template literal quasis (the static text portions).
//
// Identifiers are NOT scanned — a variable named `cellPrivado` would NOT
// trigger the rule (the boundary check requires the stopword to stand
// alone, not be embedded). Override per-line via:
//
//   // eslint-disable-next-line hive-local/no-spanish-leakage
//
// For legitimate cases (eg. a textually quoted name of a vault spec).
//
// Stopwords live in eslint-rules/spanish-stopwords.json so the list can
// grow without touching this file. See ADR-014 § Decisión for the initial
// list and the rationale.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STOPWORDS_PATH = path.join(__dirname, 'spanish-stopwords.json');

/** @type {{ stopwords: string[] }} */
const stopwordsConfig = JSON.parse(fs.readFileSync(STOPWORDS_PATH, 'utf8'));
const stopwords = stopwordsConfig.stopwords;

/**
 * Escape a string for safe use inside a regex character class or alternation.
 * @param {string} s
 * @returns {string}
 */
function escapeForRegex(s) {
  return s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

// Build the matcher once at module load. Word-bounded, case-insensitive,
// unicode flag for accented characters (función, decisión, etc.).
const alternation = stopwords.map(escapeForRegex).join('|');
const STOPWORD_RE = new RegExp(`\\b(${alternation})\\b`, 'giu');

/**
 * Scan a piece of text for stopword matches. Returns each match with its
 * 0-based offset inside the text, the matched word, and the canonical
 * stopword (lowercased).
 *
 * @param {string} text
 * @returns {Array<{ index: number; word: string; canonical: string }>}
 */
function findStopwords(text) {
  const out = [];
  // Reset the regex's lastIndex because the `g` flag preserves state across
  // scans — without the reset, calls would skip matches.
  STOPWORD_RE.lastIndex = 0;
  let match;
  while ((match = STOPWORD_RE.exec(text)) !== null) {
    out.push({
      index: match.index,
      word: match[0],
      canonical: match[0].toLowerCase(),
    });
  }
  return out;
}

/**
 * Translate a 0-based offset within a multi-line `text` to an
 * `{ line, column }` pair, where `start` is the loc of the first char of
 * `text` in the source. Lines are 1-based and columns are 0-based, matching
 * ESLint's loc convention.
 *
 * @param {string} text
 * @param {number} offset
 * @param {{ line: number; column: number }} start
 * @returns {{ line: number; column: number }}
 */
function offsetToLoc(text, offset, start) {
  let line = start.line;
  let column = start.column;
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 0x0a /* \n */) {
      line += 1;
      column = 0;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow Spanish stopwords in code. Enforces CLAUDE.md regla #3 + ADR-014.',
    },
    schema: [],
    messages: {
      stopword:
        'Spanish word "{{word}}" detected — repo code must be in English (CLAUDE.md regla #3, ADR-014). Use `// eslint-disable-next-line hive-local/no-spanish-leakage` with a justifying comment if the case is legitimate.',
    },
  },

  create(context) {
    const sourceCode = context.sourceCode;

    /**
     * Report a stopword match found inside `text` whose first char sits at
     * `start` in the source. The report's loc points at the matched word.
     *
     * @param {{ index: number; word: string }} hit
     * @param {string} text
     * @param {{ line: number; column: number }} start
     */
    function reportHit(hit, text, start) {
      const matchStart = offsetToLoc(text, hit.index, start);
      const matchEnd = offsetToLoc(text, hit.index + hit.word.length, start);
      context.report({
        loc: { start: matchStart, end: matchEnd },
        messageId: 'stopword',
        data: { word: hit.word },
      });
    }

    return {
      Program() {
        // Comments are not part of the AST visitor protocol — fetch them
        // explicitly. Includes both Line (`//`) and Block (`/* */`, JSDoc).
        const comments = sourceCode.getAllComments();
        for (const comment of comments) {
          // `comment.value` is the text without the delimiters. The first
          // char of `value` sits at `loc.start.column + 2` (`//` or `/*`).
          const start = {
            line: comment.loc.start.line,
            column: comment.loc.start.column + 2,
          };
          const hits = findStopwords(comment.value);
          for (const hit of hits) {
            reportHit(hit, comment.value, start);
          }
        }
      },

      Literal(node) {
        // String literals only. Numeric / null / regex literals are out
        // of scope.
        if (typeof node.value !== 'string') return;
        // The opening quote occupies one char before the value content.
        const start = {
          line: node.loc.start.line,
          column: node.loc.start.column + 1,
        };
        const hits = findStopwords(node.value);
        for (const hit of hits) {
          reportHit(hit, node.value, start);
        }
      },

      TemplateElement(node) {
        // Each TemplateElement contains a static slice of a template
        // literal. `value.raw` preserves escapes verbatim; `value.cooked`
        // normalises them. We scan `cooked` (the actual rendered prose).
        // The opening backtick / `}` occupies one char before the slice.
        const cooked = node.value.cooked ?? node.value.raw;
        const start = {
          line: node.loc.start.line,
          column: node.loc.start.column + 1,
        };
        const hits = findStopwords(cooked);
        for (const hit of hits) {
          reportHit(hit, cooked, start);
        }
      },
    };
  },
};

export default rule;
