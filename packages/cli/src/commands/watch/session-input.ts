// Session modes of `hivectl watch` (ADR-026, tech spec § "watch: modo harness"):
//   harness — `--session-name --session-description --exec`: registers one named
//             session with the enrollment credential and runs `--exec` children
//             that reach Hive through the harness state file;
//   attach  — `--attach-session <session_id>`: consumes the single stream of the
//             proxy of an interactive session through its local channel.
// Validation is local; the server stays the authority on names.

import { WatchError } from './errors.js';
import { parseServer, resolveTimings } from './input.js';
import type { RawWatchOptions, WatchTimings } from './input.js';

export interface HarnessInput extends WatchTimings {
  kind: 'harness';
  name: string;
  description: string;
  exec: { program: string; args: string[] };
  /** `--server`; without it, the URL of the folder's enrollment. */
  server: string | undefined;
  /** `--credential-file` with the enrollment credential; without it, the folder's enrollment. */
  credentialFile: string | undefined;
  stateFile: string | undefined;
  inlineMcpConfig: boolean;
}

export interface AttachInput {
  kind: 'attach';
  sessionId: string;
  once: boolean;
  /** How long an unknown session id is waited for before WATCH_ATTACH_TARGET_NOT_FOUND. */
  attachTimeoutMs: number;
}

export type SessionWatchInput = HarnessInput | AttachInput;

export const DESCRIPTION_MAX_LENGTH = 280;
/** Provisional (tech spec): first-start wait for an unknown session id. */
const ATTACH_TIMEOUT_MS = 30_000;
// eslint-disable-next-line no-control-regex -- rejects control characters in names and descriptions
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function isSessionMode(raw: RawWatchOptions): boolean {
  return (
    raw.sessionName !== undefined ||
    raw.sessionDescription !== undefined ||
    raw.attachSession !== undefined ||
    raw.stateFile !== undefined ||
    raw.inlineMcpConfig === true
  );
}

function invalid(message: string): WatchError {
  return new WatchError('WATCH_INVALID_OPTION', message);
}

function resolveAttach(raw: RawWatchOptions): AttachInput {
  const sessionId = raw.attachSession ?? '';
  if (sessionId === '' || CONTROL_CHARS.test(sessionId)) {
    throw invalid('--attach-session needs a session id');
  }
  for (const [flag, present] of [
    ['--exec', raw.exec !== undefined || raw.execArgs.length > 0],
    ['--server', raw.server !== undefined],
    ['--credential-file', raw.credentialFile !== undefined],
    ['--session-name', raw.sessionName !== undefined],
    ['--session-description', raw.sessionDescription !== undefined],
    ['--state-file', raw.stateFile !== undefined],
    ['--inline-mcp-config', raw.inlineMcpConfig === true],
  ] as const) {
    if (present) throw invalid(`--attach-session cannot be used with ${flag}`);
  }
  return { kind: 'attach', sessionId, once: raw.once === true, attachTimeoutMs: ATTACH_TIMEOUT_MS };
}

export function resolveSessionWatchInput(
  raw: RawWatchOptions,
  env: NodeJS.ProcessEnv,
): SessionWatchInput {
  if (raw.attachSession !== undefined && raw.sessionName === undefined) return resolveAttach(raw);

  const name = raw.sessionName;
  if (name === undefined) {
    throw invalid(
      '--session-description, --state-file and --inline-mcp-config need --session-name',
    );
  }
  if (raw.attachSession !== undefined) {
    throw invalid('--session-name and --attach-session cannot be used together');
  }
  if (raw.once === true) throw invalid('--session-name and --once cannot be used together');
  if (name === '' || CONTROL_CHARS.test(name)) {
    throw invalid('--session-name must be a non-empty name without control characters');
  }
  const description = raw.sessionDescription;
  if (description === undefined) throw invalid('--session-name needs --session-description');
  if (description === '' || CONTROL_CHARS.test(description)) {
    throw invalid('--session-description must be one non-empty line without control characters');
  }
  if (description.length > DESCRIPTION_MAX_LENGTH) {
    throw invalid(
      `--session-description must be at most ${String(DESCRIPTION_MAX_LENGTH)} characters`,
    );
  }
  if (raw.exec === undefined) throw invalid('--session-name needs --exec');

  return {
    kind: 'harness',
    name,
    description,
    exec: { program: raw.exec, args: raw.execArgs },
    server: raw.server === undefined ? undefined : parseServer(raw.server),
    credentialFile: raw.credentialFile,
    stateFile: raw.stateFile,
    inlineMcpConfig: raw.inlineMcpConfig === true,
    ...resolveTimings(raw, env),
  };
}
