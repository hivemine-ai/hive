// `hivectl hive list-keepers [--active-only]` — read-only, no audit event.
// Per the tech spec the original Slice 0 used SQL direct (workaround); since
// the delta `participantsRepo.listHivekeepers` is now available we use it
// directly.

import type { CliRuntime } from '@hive/server';

import type { GlobalCliOpts } from '#types.js';

export interface ListKeepersOpts {
  globals: GlobalCliOpts;
  activeOnly: boolean | undefined;
  limit: number | undefined;
}

export interface ListedKeeper {
  id: string;
  email: string;
  displayName: string | null;
  isAdmin: boolean;
  state: 'active' | 'revoked';
  createdAt: Date;
}

export async function runListKeepers(
  runtime: CliRuntime,
  opts: ListKeepersOpts,
): Promise<{ keepers: ListedKeeper[] }> {
  const filter: Parameters<typeof runtime.participantsWriteRepo.listHivekeepers>[0] = {
    hiveId: runtime.hiveStableIdentifier,
    pagination: { cursor: null, limit: opts.limit ?? 50 },
  };
  if (opts.activeOnly === true) filter.state = 'active';

  const result = await runtime.participantsWriteRepo.listHivekeepers(filter);
  return {
    keepers: result.hivekeepers.map((hk) => ({
      id: hk.id,
      email: hk.email,
      displayName: hk.displayName,
      isAdmin: hk.isAdmin,
      state: hk.state,
      createdAt: hk.createdAt,
    })),
  };
}
