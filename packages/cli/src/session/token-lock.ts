// Exclusive, non-blocking, process-scoped OS lock on a file, held for the life of
// the process and released by the OS when the process dies (including `kill -9`).
//
// Node has no `flock`. SQLite's unix VFS takes POSIX advisory locks (fcntl) on its
// database file, which the kernel drops with the process, on macOS and Linux alike,
// and tracks them per inode inside one process as well. An exclusive transaction on
// an empty database file is therefore the portable equivalent of
// `flock(LOCK_EX | LOCK_NB)`. better-sqlite3 already ships with hivectl.

import { chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import Database from 'better-sqlite3';

import { ensurePrivateDir } from './state-dir.js';

export interface HeldLock {
  release(): void;
}

/**
 * Locks held by this process, by path. Two reasons: a handle nobody references
 * could be garbage collected, which closes its database and drops the lock; and
 * POSIX drops every fcntl lock a process holds on a file as soon as the process
 * closes any descriptor of it, so a second attempt on a held path must not open
 * the file at all.
 */
const held = new Map<string, Database.Database>();

/** Takes the lock or returns undefined at once if someone else, or this process, holds it. */
export function tryExclusiveLock(path: string): HeldLock | undefined {
  const key = resolve(path);
  if (held.has(key)) return undefined;
  ensurePrivateDir(dirname(key));
  const db = new Database(key, { timeout: 0 });
  try {
    chmodSync(key, 0o600);
    db.pragma('journal_mode = OFF');
    db.pragma('locking_mode = EXCLUSIVE');
    db.exec('BEGIN EXCLUSIVE');
  } catch (err) {
    db.close();
    if ((err as { code?: unknown }).code === 'SQLITE_BUSY') return undefined;
    throw err;
  }
  held.set(key, db);
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      held.delete(key);
      db.close();
    },
  };
}
