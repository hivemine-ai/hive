// Map any thrown error from a CLI command handler to an exit code + message.
// hivectl is `caller trusted` per [[Auth + Identity]] — the human-readable
// message includes the semantic `code` AND the `subCode` when available.

import { isAuditError, isAuthError, isCellError } from '@hive/server';

import { isCliError } from './cli-error.js';
import type { CliError } from './cli-error.js';
import {
  EXIT_INTERNAL,
  EXIT_INTERRUPTED,
  EXIT_NOT_FOUND,
  EXIT_PERMISSION,
  EXIT_PRECONDITION,
  EXIT_USER_ERROR,
} from './exit-codes.js';
import type { ExitCode } from './exit-codes.js';

export interface MappedExit {
  code: ExitCode;
  message: string;
}

export function mapErrorToExit(err: unknown): MappedExit {
  if (isCliError(err)) return mapCliError(err);
  if (isAuthError(err)) return mapAuthError(err);
  if (isCellError(err)) return mapCellError(err);
  if (isAuditError(err)) return mapAuditError(err);
  if (err instanceof Error) {
    return { code: EXIT_INTERNAL, message: `internal error: ${err.message}` };
  }
  return { code: EXIT_INTERNAL, message: `internal error: ${String(err)}` };
}

function mapCliError(err: CliError): MappedExit {
  const suffix = err.subCode ? ` (${err.subCode})` : '';
  switch (err.code) {
    case 'HIVE_NOT_INITIALIZED':
      return {
        code: EXIT_PRECONDITION,
        message: `hive not initialized${suffix}; run 'hivectl init' first`,
      };
    case 'HIVE_ALREADY_INITIALIZED':
      return {
        code: EXIT_PRECONDITION,
        message: `hive already initialized${suffix}; use 'hivectl hive list-keepers' to inspect`,
      };
    case 'OPERATOR_ID_INVALID':
      return {
        code: EXIT_USER_ERROR,
        message: `invalid --operator-id${suffix}`,
      };
    case 'OPERATOR_ID_NOT_ADMIN':
      return {
        code: EXIT_PERMISSION,
        message: `--operator-id is not an active admin${suffix}`,
      };
    case 'CONFIRMATION_DECLINED':
      return {
        code: EXIT_USER_ERROR,
        message: `confirmation declined${suffix}`,
      };
    case 'INTERRUPTED':
      return {
        code: EXIT_INTERRUPTED,
        message: `operation interrupted${suffix}`,
      };
    case 'CONFIG_INVALID':
      return {
        code: EXIT_USER_ERROR,
        message: `invalid configuration${suffix}: ${err.message}`,
      };
    case 'UNSUPPORTED_PLATFORM':
      return {
        code: EXIT_USER_ERROR,
        message: `unsupported platform${suffix}: ${err.message}`,
      };
    case 'ROOT_REQUIRED':
      return {
        code: EXIT_PRECONDITION,
        message: `root privilege required${suffix}: ${err.message}`,
      };
    case 'WORKING_DIR_PERMISSION':
      return {
        code: EXIT_PRECONDITION,
        message: `cannot access working directory${suffix}: ${err.message}`,
      };
    case 'SERVICE_NOT_INSTALLED':
      return {
        code: EXIT_PRECONDITION,
        message: `service not installed${suffix}: ${err.message}`,
      };
    default: {
      const exhaustive: never = err.code;
      return {
        code: EXIT_INTERNAL,
        message: `unhandled CLI error code: ${String(exhaustive)}`,
      };
    }
  }
}

function mapAuthError(err: {
  code: string;
  subCode?: string | undefined;
  message: string;
}): MappedExit {
  const suffix = err.subCode ? ` (${err.subCode})` : '';
  switch (err.code) {
    case 'PARTICIPANT_NOT_FOUND':
    case 'PARTICIPANT_NOT_FOUND_FOR_ISSUE':
      return { code: EXIT_NOT_FOUND, message: `participant not found${suffix}` };
    case 'PARTICIPANT_NOT_ACTIVE':
      return { code: EXIT_PRECONDITION, message: `participant not active${suffix}` };
    case 'CREDENTIAL_ALREADY_REVOKED':
      return {
        code: EXIT_PRECONDITION,
        message: `credential already revoked${suffix}; use 'credential issue' for a new one`,
      };
    case 'INVALID_STATE_TRANSITION':
      return { code: EXIT_PRECONDITION, message: `invalid state transition${suffix}` };
    case 'LAST_ADMIN_INVARIANT':
      return {
        code: EXIT_PRECONDITION,
        message: `cannot remove admin: this is the last active admin in the Hive`,
      };
    case 'INVALID_INPUT':
      return { code: EXIT_USER_ERROR, message: `invalid input${suffix}` };
    case 'EMAIL_TAKEN':
      return { code: EXIT_PRECONDITION, message: `email already in use${suffix}` };
    case 'AGENT_NAME_TAKEN':
      return {
        code: EXIT_PRECONDITION,
        message: `agent name already in use under this owner${suffix}`,
      };
    case 'INSUFFICIENT_PRIVILEGE':
      return { code: EXIT_PERMISSION, message: `insufficient privilege${suffix}` };
    case 'HIVE_ALREADY_INITIALIZED':
      return {
        code: EXIT_PRECONDITION,
        message: `hive already initialized${suffix}`,
      };
    default:
      return {
        code: EXIT_INTERNAL,
        message: `auth error ${err.code}${suffix}: ${err.message}`,
      };
  }
}

function mapCellError(err: {
  code: string;
  subCode?: string | undefined;
  message: string;
}): MappedExit {
  const suffix = err.subCode ? ` (${err.subCode})` : '';
  switch (err.code) {
    case 'CELL_NOT_FOUND':
      return { code: EXIT_NOT_FOUND, message: `cell not found${suffix}` };
    case 'INVALID_INPUT':
      return { code: EXIT_USER_ERROR, message: `invalid input${suffix}` };
    case 'RECIPIENT_UNREACHABLE':
      return { code: EXIT_USER_ERROR, message: `target unreachable${suffix}` };
    case 'INSUFFICIENT_PRIVILEGE':
      return { code: EXIT_PERMISSION, message: `insufficient privilege${suffix}` };
    default:
      return {
        code: EXIT_INTERNAL,
        message: `cell error ${err.code}${suffix}: ${err.message}`,
      };
  }
}

function mapAuditError(err: {
  code: string;
  subCode?: string | undefined;
  message: string;
}): MappedExit {
  const suffix = err.subCode ? ` (${err.subCode})` : '';
  switch (err.code) {
    case 'INVALID_INPUT':
      return { code: EXIT_USER_ERROR, message: `invalid audit input${suffix}` };
    case 'INSUFFICIENT_PRIVILEGE':
      return { code: EXIT_PERMISSION, message: `audit query requires admin${suffix}` };
    default:
      return {
        code: EXIT_INTERNAL,
        message: `audit error ${err.code}${suffix}: ${err.message}`,
      };
  }
}
