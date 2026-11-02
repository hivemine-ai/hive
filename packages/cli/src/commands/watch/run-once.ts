// `hivectl watch --once`: one `check_unread_messages` call, one line if anything
// is unread, nothing otherwise. It opens no stream, so it creates no presence.

import { buildQueryEvent, checkUnread, isListenError, serializeEventLine } from '@hive/client';
import { HIVE_VERSION } from '@hive/shared';

import { readCredential } from './credential.js';
import { WatchError } from './errors.js';
import type { WatchInput } from './input.js';
import type { WatchIo } from './io.js';

export async function runWatchOnce(input: WatchInput, io: WatchIo): Promise<number> {
  const credential = readCredential(input.credentialFile);
  let summary;
  try {
    summary = await checkUnread({
      url: input.server,
      credential,
      probeTimeoutMs: input.probeTimeoutMs,
      clientVersion: HIVE_VERSION,
    });
  } catch (err) {
    if (isListenError(err) && err.kind === 'auth_rejected') {
      throw new WatchError('WATCH_CREDENTIAL_REJECTED', 'the server rejected the credential', {
        cause: err,
      });
    }
    if (isListenError(err) && err.kind === 'protocol_unsupported') {
      throw new WatchError('WATCH_PROTOCOL_UNSUPPORTED', err.message, { cause: err });
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new WatchError('WATCH_ONCE_FAILED', `could not check unread messages: ${reason}`, {
      cause: err,
    });
  }
  const event = buildQueryEvent(summary);
  if (event !== null) io.stdout(`${serializeEventLine(event)}\n`);
  return 0;
}
