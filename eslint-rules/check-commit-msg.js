#!/usr/bin/env node
// Husky `commit-msg` hook script: scan a commit message file for Spanish
// stopwords and exit non-zero on match. Complements the
// `no-spanish-leakage` ESLint rule (which scans .ts/.tsx) by extending the
// CLAUDE.md regla #3 + ADR-014 enforcement to commit message bodies.
//
// Usage (called by husky):
//   node eslint-rules/check-commit-msg.js "$1"
// Where $1 is the path to the commit message file (e.g. .git/COMMIT_EDITMSG).
//
// Behavior:
//   - Reads the file as UTF-8.
//   - Skips lines starting with `#` (git commit message comments).
//   - Skips empty lines.
//   - Matches stopwords with the same word-bounded, case-insensitive,
//     unicode-aware regex used by the ESLint rule (single source of truth:
//     eslint-rules/spanish-stopwords.json).
//   - On match: prints offending line + line number + matched stopwords to
//     stderr and exits 1. Includes a one-line hint about `--no-verify`.
//   - On no match (or empty file): exits 0 silently.
//
// Bypass: `git commit --no-verify` skips the hook entirely (husky honors
// the flag). See CLAUDE.md regla #3 for when bypass is justified.

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
 * Same helper as no-spanish-leakage.js — duplicated here to keep the two
 * scripts independent (no cross-import gymnastics for a 6-line function).
 *
 * @param {string} s
 * @returns {string}
 */
function escapeForRegex(s) {
  return s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

const alternation = stopwords.map(escapeForRegex).join('|');
const STOPWORD_RE = new RegExp(`\\b(${alternation})\\b`, 'giu');

/**
 * Find stopword matches in a single line.
 *
 * @param {string} line
 * @returns {string[]} matched stopwords (verbatim, in encounter order)
 */
function findStopwordsInLine(line) {
  STOPWORD_RE.lastIndex = 0;
  const out = [];
  let match;
  while ((match = STOPWORD_RE.exec(line)) !== null) {
    out.push(match[0]);
  }
  return out;
}

/**
 * Scan the commit message file and collect violations.
 *
 * @param {string} filePath
 * @returns {Array<{ line: number; text: string; words: string[] }>}
 */
function scanCommitMsg(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const violations = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) continue;
    if (line.startsWith('#')) continue;
    const hits = findStopwordsInLine(line);
    if (hits.length > 0) {
      violations.push({ line: i + 1, text: line, words: hits });
    }
  }
  return violations;
}

function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    process.stderr.write('check-commit-msg: missing commit message file path argument\n');
    process.exit(2);
  }
  if (!fs.existsSync(filePath)) {
    process.stderr.write(`check-commit-msg: file not found: ${filePath}\n`);
    process.exit(2);
  }

  const violations = scanCommitMsg(filePath);
  if (violations.length === 0) {
    process.exit(0);
  }

  process.stderr.write(
    '✗ Commit message contains Spanish stopwords (CLAUDE.md regla #3, ADR-014):\n',
  );
  for (const v of violations) {
    const wordList = v.words.map((w) => `"${w}"`).join(', ');
    process.stderr.write(`  line ${v.line}: ${v.text}\n`);
    process.stderr.write(`           → ${wordList}\n`);
  }
  process.stderr.write(
    '\nRewrite the commit message in English, or use `git commit --no-verify`\n' +
      'with a justification in the body if the Spanish term is unavoidable\n' +
      '(e.g., quoting a vault spec name verbatim).\n',
  );
  process.exit(1);
}

main();
