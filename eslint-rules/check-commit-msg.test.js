// Tests for the `check-commit-msg.js` Husky hook script (ADR-014, PRY-021).
// Run via `node --test eslint-rules/*.test.js` (Node 22+ built-in runner),
// chained as the root `pnpm test:rules` script.
//
// Strategy: each test writes a temp commit message file, invokes the script
// as a child process, and asserts on exit code + stderr.

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, test } from 'node:test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPT_PATH = path.join(__dirname, 'check-commit-msg.js');

/** @type {string} */
let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-commit-msg-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Write `content` to a temp commit message file and run the script.
 *
 * @param {string} content
 * @returns {{ status: number | null; stderr: string; stdout: string }}
 */
function runOn(content) {
  const filePath = path.join(tmpDir, 'COMMIT_EDITMSG');
  fs.writeFileSync(filePath, content, 'utf8');
  const result = spawnSync(process.execPath, [SCRIPT_PATH, filePath], {
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

describe('check-commit-msg.js', () => {
  // ── exits 0: things the script must NOT flag ─────────────────────────────

  test('English-only commit message passes', () => {
    const result = runOn('feat(server): add a new feature\n\nThis describes the change.\n');
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
  });

  test('lines starting with # are ignored', () => {
    const result = runOn(
      [
        'feat(server): valid english header',
        '',
        'Body in english only.',
        '',
        '# Por favor introduce un mensaje de commit',
        '# función opcional como ejemplo en el comentario',
        '# Cualquier línea comenzando con # es ignorada',
      ].join('\n'),
    );
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
  });

  test('stopword embedded in identifier does NOT match', () => {
    // `cellPrivado` is a single word with `Privado` embedded, but the
    // regex is word-bounded so it should NOT match (`\b` requires a word
    // boundary — letter boundaries within camelCase do not count).
    const result = runOn('refactor: rename cellPrivado to cellPrivate\n');
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
  });

  test('empty file passes', () => {
    const result = runOn('');
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
  });

  test('only-whitespace and only-comment file passes', () => {
    const result = runOn('\n\n# comment in spanish: validar la función\n\n');
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
  });

  // ── exits 1: things the script MUST flag ─────────────────────────────────

  test('Spanish stopword in commit body fails', () => {
    const result = runOn('feat: add feature\n\nEsta función hace algo importante.\n');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /función/);
    assert.match(result.stderr, /line 3/);
  });

  test('case-insensitive match — UPPERCASE', () => {
    const result = runOn('feat: add feature\n\nHITO 5 marcado.\n');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /HITO/);
  });

  test('case-insensitive match — Capitalized', () => {
    const result = runOn('feat: add feature\n\nHito 5 marcado.\n');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Hito/);
  });

  test('multi-word stopword "una vez" matches', () => {
    const result = runOn('feat: add feature\n\nLlamar una vez en construction.\n');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /una vez/);
  });

  test('accented stopword "decisión" matches', () => {
    const result = runOn('feat: add feature\n\nLa decisión está documentada.\n');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /decisión/);
  });

  test('multiple stopwords on the same line are all reported', () => {
    const result = runOn('feat: header\n\nBloque privado con decisión opcional.\n');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Bloque/);
    assert.match(result.stderr, /privado/);
    assert.match(result.stderr, /decisión/);
    assert.match(result.stderr, /opcional/);
  });

  test('stopword in subject line fails (line 1)', () => {
    const result = runOn('feat: implementa la función nueva\n');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /línea?\s*1|line\s*1/i);
    assert.match(result.stderr, /función/);
  });

  test('stopword in body but not in `#` comment line is reported only for body', () => {
    const result = runOn(
      [
        'feat: english subject',
        '',
        'Esta función es importante.',
        '',
        '# función used in comment is fine and ignored',
      ].join('\n'),
    );
    assert.equal(result.status, 1);
    // Body line (line 3) reported.
    assert.match(result.stderr, /line 3/);
    // The hint about --no-verify must be present.
    assert.match(result.stderr, /--no-verify/);
  });

  // ── exits 2: misuse ─────────────────────────────────────────────────────

  test('missing arg exits 2', () => {
    const result = spawnSync(process.execPath, [SCRIPT_PATH], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /missing/);
  });

  test('non-existent file exits 2', () => {
    const result = spawnSync(
      process.execPath,
      [SCRIPT_PATH, path.join(tmpDir, 'does-not-exist.txt')],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /not found/);
  });
});
