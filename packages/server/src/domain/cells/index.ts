// Public barrel for the Cell Store domain.

export { CellError, isCellError } from './errors.js';
export type { CellErrorCode, CellErrorOptions } from './errors.js';

export type {
  ActionDescriptor,
  Cell,
  CellState,
  MarkReadInput,
  MarkReadResult,
  Message,
  MessageState,
  MessageType,
  MessageView,
  Pagination,
  ReadMailboxFilter,
  ReadMailboxInput,
  RetentionPolicy,
  SendMessageInput,
  SendResult,
} from './types.js';

export { createCellsRepo, mapKindToOwnerKind } from './repository.js';
export type {
  CellsRepo,
  CloseCellInput,
  CloseCellResult,
  CreateCellInput,
  GetCellStateResult,
  ListMessagesFilter,
  ListMessagesPagination,
  MarkMessageReadResult,
  SummarizeUnreadResult,
} from './repository.js';
// `DbExecutor` is also exported by `domain/auth` (cells-hook). Both refer to the
// same Kysely executor union; we avoid the ambiguous wildcard re-export here.
// Internal callers that need the type can import it directly from
// `#domain/cells/repository.js` or `#domain/auth/index.js`.

// Send/Read pipeline.
export { createCellEvents } from './events.js';
export type {
  CellClosedEvent,
  CellEventListener,
  CellEventMap,
  CellEventName,
  CellEvents,
  MessageDeliveredEvent,
} from './events.js';

export { createSender, DEFAULT_SENDER_CONFIG } from './send.js';
export type { Sender, SenderConfig, SenderDeps } from './send.js';

export { createReader, DEFAULT_READER_CONFIG } from './read.js';
export type { Reader, ReaderConfig, ReaderDeps } from './read.js';

// The Visibility Engine contract used by `send.ts` lives in `domain/visibility/`
// (PRY-004). It is consumed by Cell Store but owned by Visibility — downstream
// callers import it from `@hive/server` (re-exported by the package barrel) or
// `#domain/visibility/index.js` (intra-server).
