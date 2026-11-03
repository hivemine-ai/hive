// Reads the participant credential from a file. The value is never accepted on
// argv, stdin or the environment, and never appears in an error message.

import { readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

import { WatchError } from './errors.js';

const GROUP_OR_OTHER = 0o077;

function modeOf(path: string): number | undefined {
  try {
    return statSync(path).mode;
  } catch {
    return undefined;
  }
}

export function readCredential(path: string, platform: NodeJS.Platform = process.platform): string {
  const fileMode = modeOf(path);
  if (fileMode === undefined) {
    throw new WatchError(
      'WATCH_CREDENTIAL_MISSING',
      `cannot read the credential file ${path}; pass --credential-file or set HIVE_WATCH_CREDENTIAL_FILE`,
    );
  }
  if (platform !== 'win32') {
    if ((fileMode & GROUP_OR_OTHER) !== 0) {
      throw new WatchError(
        'WATCH_CREDENTIAL_INSECURE_PERMS',
        `${path} must be readable by its owner only (chmod 600)`,
      );
    }
    const dir = dirname(path);
    const dirMode = modeOf(dir);
    if (dirMode !== undefined && (dirMode & GROUP_OR_OTHER) !== 0) {
      throw new WatchError(
        'WATCH_CREDENTIAL_INSECURE_PERMS',
        `${dir} must be accessible by its owner only (chmod 700)`,
      );
    }
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf8').trim();
  } catch {
    throw new WatchError('WATCH_CREDENTIAL_MISSING', `cannot read the credential file ${path}`);
  }
  if (text === '') {
    throw new WatchError('WATCH_CREDENTIAL_MISSING', `the credential file ${path} is empty`);
  }
  return text;
}
