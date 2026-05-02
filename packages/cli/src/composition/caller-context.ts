// Caller context for CLI invocations — single-Hive simplification per ADR-020.
//
// The MCP wire threads `IdentityContext.hiveName` from the JWT verifier per
// ADR-015. The CLI cannot do that (it has no JWT), so it sources `hiveName`
// + `hiveId` from the runtime built by `startCli` (which already loads the
// single Hive row at boot — zero additional queries per command).
//
// `parseReference(input, ctx.hiveName)` from `@hive/server` consumes
// `hiveName` to disambiguate agent references from Hivekeeper emails.
//
// Deviation from the PRY-039 spec (which proposed `loadCliCallerContext(db):
// Promise<CliCallerContext>` with module-level cache): taking `runtime`
// directly avoids both an extra DB query and a CLI-side dependency on the
// `kysely` types (which @hive/cli does not pull in directly). Accepted as
// local scope adjustment per lesson PRY-038 (inline adjustment when the
// discovery is local to the PRY and does not affect cross-spec contracts).

import type { CliRuntime, UUIDv7 } from '@hive/server';

export interface CliCallerContext {
  readonly hiveId: UUIDv7;
  readonly hiveName: string;
}

/** Extract the caller context fields from the runtime. */
export function getCliCallerContext(runtime: CliRuntime): CliCallerContext {
  return { hiveId: runtime.hiveStableIdentifier, hiveName: runtime.hiveName };
}
