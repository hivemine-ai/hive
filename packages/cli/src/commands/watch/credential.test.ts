import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readCredential } from './credential.js';
import { thrownCode } from './test-utils.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hive-cred-'));
  chmodSync(dir, 0o700);
  file = join(dir, 'credential');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('readCredential', () => {
  it('returns the trimmed credential of a 0600 file in a 0700 folder', () => {
    writeFileSync(file, '  header.payload.sig\n', { mode: 0o600 });
    expect(readCredential(file)).toBe('header.payload.sig');
  });

  it('fails with WATCH_CREDENTIAL_MISSING when the file does not exist', () => {
    expect(thrownCode(() => readCredential(join(dir, 'nope')))).toBe('WATCH_CREDENTIAL_MISSING');
  });

  it('fails with WATCH_CREDENTIAL_MISSING when the file is empty', () => {
    writeFileSync(file, '\n', { mode: 0o600 });
    expect(thrownCode(() => readCredential(file))).toBe('WATCH_CREDENTIAL_MISSING');
  });

  it.each([0o644, 0o640, 0o604, 0o660])('fails fast on file mode %o', (mode) => {
    writeFileSync(file, 'tok', { mode: 0o600 });
    chmodSync(file, mode);
    expect(thrownCode(() => readCredential(file))).toBe('WATCH_CREDENTIAL_INSECURE_PERMS');
  });

  it('fails fast when the containing folder is open to group or others', () => {
    const open = join(dir, 'open');
    mkdirSync(open);
    chmodSync(open, 0o755);
    const inner = join(open, 'credential');
    writeFileSync(inner, 'tok', { mode: 0o600 });
    expect(thrownCode(() => readCredential(inner))).toBe('WATCH_CREDENTIAL_INSECURE_PERMS');
  });

  it('never puts the credential in an error message', () => {
    writeFileSync(file, 'super-secret-value', { mode: 0o600 });
    chmodSync(file, 0o644);
    try {
      readCredential(file);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain('super-secret-value');
    }
  });
});
