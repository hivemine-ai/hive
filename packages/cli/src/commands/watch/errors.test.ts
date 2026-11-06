import { ListenError } from '@hive/client';
import { describe, expect, it } from 'vitest';

import { EXIT_INTERNAL, EXIT_PRECONDITION, EXIT_USER_ERROR } from '#error/exit-codes.js';

import { WatchError, mapWatchError } from './errors.js';
import type { WatchErrorCode } from './errors.js';

describe('mapWatchError', () => {
  it.each<[WatchErrorCode, number]>([
    ['WATCH_CREDENTIAL_MISSING', EXIT_USER_ERROR],
    ['WATCH_CREDENTIAL_INSECURE_PERMS', EXIT_PRECONDITION],
    ['WATCH_CREDENTIAL_REJECTED', EXIT_PRECONDITION],
    ['WATCH_PROTOCOL_UNSUPPORTED', EXIT_PRECONDITION],
    ['WATCH_EXEC_FAILED', EXIT_INTERNAL],
    ['WATCH_ONCE_EXEC_CONFLICT', EXIT_USER_ERROR],
    ['WATCH_ONCE_FAILED', EXIT_INTERNAL],
    ['WATCH_SERVER_URL_MISSING', EXIT_USER_ERROR],
    ['WATCH_INVALID_OPTION', EXIT_USER_ERROR],
    ['WATCH_SESSION_NAME_IN_USE', EXIT_PRECONDITION],
    ['WATCH_SESSION_REGISTER_REJECTED', EXIT_PRECONDITION],
    ['WATCH_STATE_FILE_INSECURE', EXIT_PRECONDITION],
    ['WATCH_ATTACH_TARGET_NOT_FOUND', EXIT_USER_ERROR],
  ])('%s exits with %i and leads the message with its code', (code, exit) => {
    const mapped = mapWatchError(new WatchError(code, 'detail'));
    expect(mapped.code).toBe(exit);
    expect(mapped.message).toBe(`${code}: detail`);
  });

  it('maps an unsupported protocol raised by the client library', () => {
    const mapped = mapWatchError(new ListenError('protocol_unsupported', 'no 2026-07-28'));
    expect(mapped.code).toBe(EXIT_PRECONDITION);
    expect(mapped.message.startsWith('WATCH_PROTOCOL_UNSUPPORTED:')).toBe(true);
  });

  it('maps anything else to an internal error', () => {
    expect(mapWatchError(new Error('boom'))).toEqual({
      code: EXIT_INTERNAL,
      message: 'internal error: boom',
    });
  });
});
