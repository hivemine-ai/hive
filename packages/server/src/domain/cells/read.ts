// Read-side operations for the Cell Store domain (PRY-003 Hito 10).
//
// `readMailbox` is purely declarative — no mutations. It resolves the caller's
// Cell, applies filters/pagination via the repository (which already filters
// out `state='expired'` per B0 invariant), and returns the consumer-facing
// MessageView projection.
//
// `markRead` performs N independent UPDATEs (one per messageId). Per tech spec
// it is NOT a transaction — each ack is independent. The result captures
// per-id success/skip uniformly: messages from another Cell, already-read,
// expired, or unknown all collapse to "ignored" (privacidad uniforme).

import type { Kysely } from 'kysely';

import type { UUIDv7 } from '#domain/auth/types.js';
import type { Database } from '#persistence/schema.js';

import { CellError } from './errors.js';
import type { CellsRepo, ListMessagesFilter } from './repository.js';
import type { MarkReadInput, MarkReadResult, MessageView, ReadMailboxInput } from './types.js';

// ---------- Public surface ----------

export interface ReaderConfig {
  /** Hard cap on `pagination.limit`. Default 100; env: HIVE_CELL_READ_MAX_PAGE_SIZE. */
  readMaxPageSize: number;
  /** Used when the caller does not provide a limit. Default 50. */
  readDefaultPageSize: number;
}

export const DEFAULT_READER_CONFIG: ReaderConfig = {
  readMaxPageSize: 100,
  readDefaultPageSize: 50,
};

export interface ReaderDeps {
  cellsRepo: CellsRepo;
  /**
   * Currently unused by the read path — included for symmetry with the rest of
   * the domain (future filters that need raw queries, audit, etc.). Listed in
   * the deps to avoid a breaking change later.
   */
  db: Kysely<Database>;
  config?: Partial<ReaderConfig>;
  now?: () => Date;
}

export interface Reader {
  readMailbox(input: ReadMailboxInput): Promise<MessageView[]>;
  markRead(input: MarkReadInput): Promise<MarkReadResult>;
}

// ---------- Implementation ----------

export function createReader(deps: ReaderDeps): Reader {
  const config: ReaderConfig = { ...DEFAULT_READER_CONFIG, ...(deps.config ?? {}) };
  const now = deps.now ?? (() => new Date());

  async function readMailbox(input: ReadMailboxInput): Promise<MessageView[]> {
    const callerId = input.callerContext.participantId;
    const cell = await deps.cellsRepo.findCellByOwner(callerId);
    if (!cell) {
      // By product invariant every active participant has a Cell. If we land
      // here something inconsistent happened (e.g. an admin path created an
      // identity without going through createHivekeeper/createAgent). Surface
      // as INTERNAL_INCONSISTENCY — the API layer will translate to a generic
      // 500 without leaking the subCode.
      throw new CellError('INTERNAL_INCONSISTENCY', { subCode: 'caller_has_no_cell' });
    }

    const requestedLimit = input.pagination?.limit ?? config.readDefaultPageSize;
    const effectiveLimit = Math.min(requestedLimit, config.readMaxPageSize);

    // exactOptionalPropertyTypes: build the filter object without ever
    // assigning `undefined` to a key that has not been set explicitly.
    const filter: ListMessagesFilter = {};
    if (input.filter?.unreadOnly !== undefined) {
      filter.unreadOnly = input.filter.unreadOnly;
    }
    if (input.filter?.types !== undefined) {
      filter.types = input.filter.types;
    }

    return deps.cellsRepo.listMessages(cell.id, filter, {
      cursor: input.pagination?.cursor ?? null,
      limit: effectiveLimit,
    });
  }

  async function markRead(input: MarkReadInput): Promise<MarkReadResult> {
    const callerId = input.callerContext.participantId;
    const cell = await deps.cellsRepo.findCellByOwner(callerId);
    if (!cell) {
      throw new CellError('INTERNAL_INCONSISTENCY', { subCode: 'caller_has_no_cell' });
    }

    const marked: UUIDv7[] = [];
    const ignored: UUIDv7[] = [];
    const at = now();

    // Per tech spec: independent UPDATEs, not a transaction. A failure of
    // one row's UPDATE must not poison the others. We swallow row-level
    // exceptions into "ignored" with a logged subCode (audit responsibility
    // is at a higher layer once observability lands).
    for (const id of input.messageIds) {
      const { affected } = await deps.cellsRepo.markMessageRead(id, cell.id, at);
      if (affected === 1) {
        marked.push(id);
      } else {
        ignored.push(id);
      }
    }

    return { marked, ignored };
  }

  return { readMailbox, markRead };
}
