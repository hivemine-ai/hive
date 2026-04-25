// Ed25519 keypair store for signing JWTs.
// Per the Auth + Identity tech spec:
//   - Ed25519 keypair generated via node:crypto (no external dep).
//   - Private key persisted as PKCS#8 PEM with file mode 0600.
//   - Public key persisted as SPKI PEM (mode is irrelevant).
//   - kid = sha256(SPKI-DER bytes).hex().slice(0, 32) — deterministic per public key,
//     and the hash is computed on raw DER bytes, NOT on PEM text.
//
// In v0.1 / Slice 0 there is at most one signing key; rotation is Slice 1+.
// loadAllKeypairs returns every PEM pair found on disk so the verifier can keep
// validating tokens signed with retired keys (per "kid coexistence" decision).

import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface SigningKey {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

export interface KeypairStoreOptions {
  keysDir: string;
}

/**
 * Generates a fresh Ed25519 keypair and computes its kid.
 * The kid is derived from the SPKI DER bytes of the public key — see deriveKid.
 */
export function generateKeypair(): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { kid: deriveKid(publicKey), privateKey, publicKey };
}

/**
 * Derives the kid from the public key's SubjectPublicKeyInfo DER bytes.
 *
 * IMPORTANT: the hash is taken over the raw DER bytes (binary), NOT over the PEM text.
 * Hashing the PEM text would produce a different kid for the same key after a re-import,
 * which breaks token verification. Tests assert this invariant.
 */
export function deriveKid(publicKey: KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex').slice(0, 32);
}

function privatePemPath(keysDir: string, kid: string): string {
  return path.join(keysDir, `${kid}.private.pem`);
}

function publicPemPath(keysDir: string, kid: string): string {
  return path.join(keysDir, `${kid}.public.pem`);
}

/**
 * Persists a keypair to disk under `keysDir`. The private key file is created with mode 0600.
 * Throws if either file already exists (use a fresh kid).
 */
export async function writeKeypairToDisk(
  opts: KeypairStoreOptions,
  key: SigningKey,
): Promise<void> {
  await fs.mkdir(opts.keysDir, { recursive: true });
  const privatePem = key.privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  }) as string;
  const publicPem = key.publicKey.export({
    type: 'spki',
    format: 'pem',
  }) as string;

  // 'wx' fails if the file already exists; mode is set at creation to avoid the race
  // between writeFile and chmod.
  await fs.writeFile(privatePemPath(opts.keysDir, key.kid), privatePem, {
    mode: 0o600,
    flag: 'wx',
  });
  await fs.writeFile(publicPemPath(opts.keysDir, key.kid), publicPem, {
    mode: 0o644,
    flag: 'wx',
  });

  // Defensively reapply chmod to handle umask interference on some platforms.
  await fs.chmod(privatePemPath(opts.keysDir, key.kid), 0o600);
}

/**
 * Loads a keypair from disk by kid. Re-derives the kid from the loaded public key as a
 * sanity check; throws if the on-disk filename does not match its content's kid.
 */
export async function loadKeypairFromDisk(
  opts: KeypairStoreOptions,
  kid: string,
): Promise<SigningKey> {
  const { createPrivateKey, createPublicKey } = await import('node:crypto');
  const privatePem = await fs.readFile(privatePemPath(opts.keysDir, kid), 'utf8');
  const publicPem = await fs.readFile(publicPemPath(opts.keysDir, kid), 'utf8');
  const privateKey = createPrivateKey({ key: privatePem, format: 'pem' });
  const publicKey = createPublicKey({ key: publicPem, format: 'pem' });
  const derivedKid = deriveKid(publicKey);
  if (derivedKid !== kid) {
    throw new Error(
      `Keypair file kid mismatch: filename '${kid}' but content derives to '${derivedKid}'`,
    );
  }
  return { kid, privateKey, publicKey };
}

/**
 * Verifies that the file mode of the private PEM is exactly 0600 (no group/world bits set).
 * Throws on mismatch — used as a boot-time defense to detect tampered perms.
 */
export async function assertPrivatePemPerms(opts: KeypairStoreOptions, kid: string): Promise<void> {
  const stats = await fs.stat(privatePemPath(opts.keysDir, kid));
  // Mask to permission bits only.
  const mode = stats.mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(
      `Private PEM '${kid}.private.pem' has unsafe mode 0o${mode.toString(8)}; expected 0o600`,
    );
  }
}

/**
 * Loads every keypair found in `keysDir`. Used at boot to populate the in-memory map
 * consumed by the verifier (kid → SigningKey).
 */
export async function loadAllKeypairs(opts: KeypairStoreOptions): Promise<Map<string, SigningKey>> {
  const map = new Map<string, SigningKey>();
  let entries: string[];
  try {
    entries = await fs.readdir(opts.keysDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return map;
    throw err;
  }
  const kids = new Set<string>();
  for (const entry of entries) {
    const m = /^([0-9a-f]{32})\.private\.pem$/.exec(entry);
    if (m && m[1] !== undefined) kids.add(m[1]);
  }
  for (const kid of kids) {
    const key = await loadKeypairFromDisk(opts, kid);
    map.set(kid, key);
  }
  return map;
}
