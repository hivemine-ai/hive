// Shared CLI types. Per regla #7, every public command input is a named type.

import type { UUIDv7 } from '@hive/server';

export type OutputMode = 'table' | 'json' | 'yaml';

export interface GlobalCliOpts {
  output: OutputMode;
  yes: boolean;
  noColor: boolean;
  operatorId?: UUIDv7;
  operatorNote?: string;
  configFile?: string;
  verbose: boolean;
}

export interface OperatorActor {
  actorId: UUIDv7 | null;
  actorKind: 'system' | 'hivekeeper';
  detail: Record<string, unknown>;
}
