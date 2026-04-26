// Real implementation of `CellsRepoHook` for the auth → cells cross-domain seam.
//
// This is the composition-root wiring (PRY-003): replaces `noopCellsHook`
// (the PRY-002 stub) so that createHivekeeper / createAgent / revokeAgent actually
// create / close Cells in the same transaction as the participant write.
//
// The adapter respects the `executor` passed in by the auth caller — that's how
// the cell write participates in the parent transaction (atomicity invariant
// from the tech spec: "createAgent + createCell are committed atomically").

import type { CellsRepo } from '#domain/cells/index.js';
import type {
  CellsRepoHook,
  CloseCellHookInput,
  CreateCellHookInput,
  DbExecutor,
} from '#domain/auth/index.js';

export function createCellsHookAdapter(cellsRepo: CellsRepo): CellsRepoHook {
  return {
    async createCell(executor: DbExecutor, input: CreateCellHookInput): Promise<void> {
      // `colonyId` from the hook input is intentionally dropped — the `cells` table
      // has no `colony_id` column per the Cell Store tech spec (Cells are
      // hive-scoped, not colony-scoped).
      await cellsRepo.createCell(
        {
          ownerId: input.ownerId,
          ownerKind: input.ownerKind,
          hiveId: input.hiveId,
        },
        executor,
      );
    },

    async closeCell(executor: DbExecutor, input: CloseCellHookInput): Promise<void> {
      // closeCell by ownerId — the Cell that belongs to that participant. The
      // cells repo is idempotent on already-closed cells and on unknown owners
      // (no rows match → no-op), so re-calling is safe.
      await cellsRepo.closeCell({ ownerId: input.ownerId }, executor);
    },
  };
}
