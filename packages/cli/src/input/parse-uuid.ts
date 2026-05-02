// UUID v7 validation. Per [[ADR-005 - Formato del identificador opaco para
// participantes en Hive v0.1]] all participant IDs are UUID v7. Validation is
// case-insensitive; canonical output is lowercase.

import type { UUIDv7 } from '@hive/server';

import { CliError } from '#error/cli-error.js';

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuidV7(input: string): boolean {
  return UUID_V7_PATTERN.test(input);
}

export function parseUuidV7(input: string, fieldName = 'id'): UUIDv7 {
  const trimmed = input.trim();
  if (!isUuidV7(trimmed)) {
    throw new CliError('CONFIG_INVALID', {
      subCode: 'uuid_invalid',
      message: `${fieldName} '${input}' is not a valid UUID v7`,
    });
  }
  return trimmed.toLowerCase();
}
