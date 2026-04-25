import { createHash, createPublicKey } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertPrivatePemPerms,
  deriveKid,
  generateKeypair,
  loadAllKeypairs,
  loadKeypairFromDisk,
  writeKeypairToDisk,
} from './keypair-store.js';

describe('keypair-store', () => {
  let keysDir: string;

  beforeEach(async () => {
    keysDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-keys-'));
  });

  afterEach(async () => {
    await fs.rm(keysDir, { recursive: true, force: true });
  });

  describe('generateKeypair / deriveKid', () => {
    it('produces a kid that is exactly 32 lowercase hex chars', () => {
      const key = generateKeypair();
      expect(key.kid).toMatch(/^[0-9a-f]{32}$/);
    });

    it('the kid is deterministic per public key (re-importing same bytes yields same kid)', () => {
      const key = generateKeypair();
      const exportedDer = key.publicKey.export({
        type: 'spki',
        format: 'der',
      });
      const reImported = createPublicKey({
        key: exportedDer,
        format: 'der',
        type: 'spki',
      });
      expect(deriveKid(reImported)).toBe(key.kid);
    });

    it('CRITICAL: the kid is hashed over DER bytes, NOT over the PEM text', () => {
      // This test enforces the invariant called out in the tech spec and the PRY-002 risks
      // section: the implementation must hash the SubjectPublicKeyInfo DER bytes, not the
      // PEM textual form. Hashing PEM text would produce a different value (different prefix,
      // base64 wrapping, header lines).
      const key = generateKeypair();
      const pemText = key.publicKey.export({
        type: 'spki',
        format: 'pem',
      }) as string;
      const pemHash = createHash('sha256').update(pemText, 'utf8').digest('hex').slice(0, 32);
      expect(key.kid).not.toBe(pemHash);
    });

    it('two independently-generated keypairs have different kids', () => {
      const a = generateKeypair();
      const b = generateKeypair();
      expect(a.kid).not.toBe(b.kid);
    });
  });

  describe('writeKeypairToDisk / loadKeypairFromDisk', () => {
    it('round-trips a keypair: write then load returns the same kid + usable keys', async () => {
      const original = generateKeypair();
      await writeKeypairToDisk({ keysDir }, original);
      const loaded = await loadKeypairFromDisk({ keysDir }, original.kid);
      expect(loaded.kid).toBe(original.kid);
      // The loaded public key must hash to the same kid (sanity check on the round-trip).
      expect(deriveKid(loaded.publicKey)).toBe(original.kid);
    });

    it('private PEM file is created with mode 0o600', async () => {
      const key = generateKeypair();
      await writeKeypairToDisk({ keysDir }, key);
      await assertPrivatePemPerms({ keysDir }, key.kid);
      const stats = await fs.stat(path.join(keysDir, `${key.kid}.private.pem`));
      expect(stats.mode & 0o777).toBe(0o600);
    });

    it('writeKeypairToDisk fails if the file already exists (refuses overwrite)', async () => {
      const key = generateKeypair();
      await writeKeypairToDisk({ keysDir }, key);
      await expect(writeKeypairToDisk({ keysDir }, key)).rejects.toThrow();
    });

    it('loadKeypairFromDisk throws if the on-disk filename does not match its content kid', async () => {
      const key = generateKeypair();
      await writeKeypairToDisk({ keysDir }, key);
      // Rename the files to a fake kid; loading by that fake kid should detect the mismatch.
      const fakeKid = 'f'.repeat(32);
      await fs.rename(
        path.join(keysDir, `${key.kid}.private.pem`),
        path.join(keysDir, `${fakeKid}.private.pem`),
      );
      await fs.rename(
        path.join(keysDir, `${key.kid}.public.pem`),
        path.join(keysDir, `${fakeKid}.public.pem`),
      );
      await expect(loadKeypairFromDisk({ keysDir }, fakeKid)).rejects.toThrow(/kid mismatch/);
    });

    it('assertPrivatePemPerms throws when the private PEM has world-readable bits', async () => {
      const key = generateKeypair();
      await writeKeypairToDisk({ keysDir }, key);
      await fs.chmod(path.join(keysDir, `${key.kid}.private.pem`), 0o644);
      await expect(assertPrivatePemPerms({ keysDir }, key.kid)).rejects.toThrow(/unsafe mode/);
    });
  });

  describe('loadAllKeypairs', () => {
    it('returns an empty map when the directory does not exist', async () => {
      const map = await loadAllKeypairs({
        keysDir: path.join(keysDir, 'does-not-exist'),
      });
      expect(map.size).toBe(0);
    });

    it('returns an empty map when the directory exists but has no PEMs', async () => {
      const map = await loadAllKeypairs({ keysDir });
      expect(map.size).toBe(0);
    });

    it('loads every persisted keypair, indexed by kid', async () => {
      const a = generateKeypair();
      const b = generateKeypair();
      await writeKeypairToDisk({ keysDir }, a);
      await writeKeypairToDisk({ keysDir }, b);
      const map = await loadAllKeypairs({ keysDir });
      expect(map.size).toBe(2);
      expect(map.get(a.kid)?.kid).toBe(a.kid);
      expect(map.get(b.kid)?.kid).toBe(b.kid);
    });

    it('ignores files that do not match the kid filename pattern', async () => {
      const a = generateKeypair();
      await writeKeypairToDisk({ keysDir }, a);
      await fs.writeFile(path.join(keysDir, 'README.md'), '# notes\n');
      await fs.writeFile(path.join(keysDir, 'noise.txt'), 'noise');
      const map = await loadAllKeypairs({ keysDir });
      expect(map.size).toBe(1);
      expect(map.has(a.kid)).toBe(true);
    });
  });
});
