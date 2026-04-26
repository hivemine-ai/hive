// Public barrel for the Visibility Engine domain.

export type {
  CanSeeInput,
  CanSendInput,
  DenialReason,
  RecipientClass,
  ResolvedRecipient,
  SenderClass,
  VisibilityEngine,
} from './types.js';

export { classifyRecipient, lookup, MATRIX_ROWS, senderClass } from './matrix.js';
export type { MatrixRow } from './matrix.js';

export { createVisibilityEngine, resolveEngineConfig } from './engine.js';
export type { EngineConfig, EngineDeps } from './engine.js';
