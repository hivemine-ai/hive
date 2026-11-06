// Exclusive, non-blocking, process-scoped OS lock on a file, held for the life of
// the process and released by the OS when the process dies (including `kill -9`).
//
// Node has no `flock`. SQLite's unix VFS takes POSIX advisory locks (fcntl) on its
// database file, which the kernel drops with the process, on macOS and Linux alike,
// and tracks them per inode inside one process as well. An exclusive transaction on
// an empty database file is therefore the portable equivalent of
// `flock(LOCK_EX | LOCK_NB)`. better-sqlite3 already ships with hivectl.

import { closeSync, openSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

import { ensurePrivateDir } from './state-dir.js';

export interface HeldLock {
  release(): void;
}

/** Takes the lock or returns undefined at once if someone else holds it. */
export function tryExclusiveLock(path: string): HeldLock | undefined {
  ensurePrivateDir(dirname(path));
  closeSync(openSync(path, 'a', 0o600));
  const db = new Database(path, { timeout: 0 });
  try {
    db.pragma('journal_mode = OFF');
    db.pragma('locking_mode = EXCLUSIVE');
    db.exec('BEGIN EXCLUSIVE');
  } catch (err) {
    db.close();
    if ((err as { code?: unknown }).code === 'SQLITE_BUSY') return undefined;
    throw err;
  }
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      db.close();
    },
  };
}
