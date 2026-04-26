// Visibility matrix — derived verbatim from the product spec
// "Matriz de Visibilidad y Autorización", full visibility table section.
//
// Implementation choice (per tech spec — data-driven decision table): array
// of MatrixRow indexed in a Map keyed by `${SenderClass}|${RecipientClass}`.
// Default decision when no row matches: `deny` with
// `reason='unmapped_combination'` (defense-in-depth — the table covers all 21
// combinations, but the default closes future gaps).

import type { IdentityContext } from '#domain/auth/types.js';

import type { DenialReason, RecipientClass, ResolvedRecipient, SenderClass } from './types.js';

export interface MatrixRow {
  sender: SenderClass;
  recipient: RecipientClass;
  decision: 'allow' | 'deny';
  /** Goes to audit log on deny. Allow rows are not persisted to audit. */
  reason: DenialReason | 'allow';
  /** Verbatim from product spec — single line, descriptive. */
  productPrinciple: string;
}

/**
 * Full table — 20 rows (rows 1-19 of the product spec table plus the inserted
 * `14b` Scout → other_owner_scout entry that materializes the "Scout to any
 * Scout" rule). The row count discrepancy with the spec prose ("18 rows + 14b")
 * is documented in matrix.test.ts: rows 6, 13, 19 are the per-sender self
 * entries and row 14b extends row 14 across owners.
 */
export const MATRIX_ROWS: readonly MatrixRow[] = [
  // === Hivekeeper as sender ===
  {
    sender: 'hivekeeper',
    recipient: 'own_worker',
    decision: 'allow',
    reason: 'allow',
    productPrinciple: 'Owner reaches their private agents',
  },
  {
    sender: 'hivekeeper',
    recipient: 'own_scout',
    decision: 'allow',
    reason: 'allow',
    productPrinciple: 'Owner reaches their public agents',
  },
  {
    sender: 'hivekeeper',
    recipient: 'other_owner_scout',
    decision: 'allow',
    reason: 'allow',
    productPrinciple: 'Scouts are public',
  },
  {
    sender: 'hivekeeper',
    recipient: 'other_owner_worker',
    decision: 'deny',
    reason: 'hivekeeper_to_other_owner_worker',
    productPrinciple: 'Workers are private',
  },
  {
    sender: 'hivekeeper',
    recipient: 'other_hivekeeper',
    decision: 'allow',
    reason: 'allow',
    productPrinciple: 'Human-to-human inside the Hive',
  },
  {
    sender: 'hivekeeper',
    recipient: 'self',
    decision: 'allow',
    reason: 'allow',
    productPrinciple: 'Self-message is allowed',
  },

  // === Worker as sender ===
  {
    sender: 'worker',
    recipient: 'own_worker',
    decision: 'allow',
    reason: 'allow',
    productPrinciple: 'Same owner scope',
  },
  {
    sender: 'worker',
    recipient: 'own_scout',
    decision: 'allow',
    reason: 'allow',
    productPrinciple: 'Same owner scope',
  },
  {
    sender: 'worker',
    recipient: 'other_owner_scout',
    decision: 'allow',
    reason: 'allow',
    productPrinciple: 'Scouts are public',
  },
  {
    sender: 'worker',
    recipient: 'other_owner_worker',
    decision: 'deny',
    reason: 'worker_to_other_owner_worker',
    productPrinciple: 'Workers are private',
  },
  {
    sender: 'worker',
    recipient: 'own_hivekeeper',
    decision: 'allow',
    reason: 'allow',
    productPrinciple: 'Agent reports to its owner human',
  },
  {
    sender: 'worker',
    recipient: 'other_hivekeeper',
    decision: 'deny',
    reason: 'worker_to_other_hivekeeper',
    productPrinciple: 'Workers cannot reach foreign humans',
  },
  {
    sender: 'worker',
    recipient: 'self',
    decision: 'allow',
    reason: 'allow',
    productPrinciple: 'Self-message is allowed',
  },

  // === Scout as sender ===
  {
    sender: 'scout',
    recipient: 'own_scout',
    decision: 'allow',
    reason: 'allow',
    productPrinciple: 'Scout-to-Scout allowed',
  },
  // Row 14b — Scout → other_owner_scout (Scouts can talk to each other across owners).
  {
    sender: 'scout',
    recipient: 'other_owner_scout',
    decision: 'allow',
    reason: 'allow',
    productPrinciple: 'Scout-to-Scout allowed (any owner)',
  },
  {
    sender: 'scout',
    recipient: 'own_worker',
    decision: 'allow',
    reason: 'allow',
    productPrinciple: 'Same owner scope',
  },
  {
    sender: 'scout',
    recipient: 'other_owner_worker',
    decision: 'deny',
    reason: 'scout_to_other_owner_worker',
    productPrinciple: 'Workers are private',
  },
  {
    sender: 'scout',
    recipient: 'own_hivekeeper',
    decision: 'allow',
    reason: 'allow',
    productPrinciple: 'Scout reports to its owner human',
  },
  {
    sender: 'scout',
    recipient: 'other_hivekeeper',
    decision: 'allow',
    reason: 'allow',
    productPrinciple: 'Scouts can write to Hive humans',
  },
  {
    sender: 'scout',
    recipient: 'self',
    decision: 'allow',
    reason: 'allow',
    productPrinciple: 'Self-message is allowed',
  },
] as const;

const MATRIX_INDEX: Map<string, MatrixRow> = new Map(
  MATRIX_ROWS.map((row) => [`${row.sender}|${row.recipient}`, row]),
);

/** Default returned when no row matches the (sender, recipient) pair. */
const UNMAPPED_DEFAULT: MatrixRow = {
  // Sentinel — sender / recipient placeholders are not consumed by callers
  // because the engine only reads `decision` and `reason` from the row.
  sender: 'worker',
  recipient: 'self',
  decision: 'deny',
  reason: 'unmapped_combination',
  productPrinciple: 'Default deny — combination not in matrix',
};

/**
 * Look up the row for a `(sender, recipient)` pair. Returns the
 * `unmapped_combination` default if no explicit row matches — defense-in-depth.
 */
export function lookup(sender: SenderClass, recipient: RecipientClass): MatrixRow {
  return MATRIX_INDEX.get(`${sender}|${recipient}`) ?? UNMAPPED_DEFAULT;
}

/**
 * Class of the sender. For agents, returns `current.type` per invariant 11
 * ("the live type wins") — NOT the snapshot from the JWT.
 */
export function senderClass(callerContext: IdentityContext): SenderClass {
  if (callerContext.kind === 'hivekeeper') return 'hivekeeper';
  // Agent — type read from the live state (verifier loaded from DB).
  const liveType = callerContext.current.type;
  if (liveType === 'worker' || liveType === 'scout') return liveType;
  // Defensive fallback — the verifier guarantees `current.type` is set for agents.
  // If we somehow hit this path, treat as worker (most restrictive sender class).
  return 'worker';
}

/**
 * Classify the recipient relative to the sender. Reads `kind`, `type`, `ownerId`
 * from the resolved recipient snapshot (loaded from the DB by the engine).
 */
export function classifyRecipient(
  callerContext: IdentityContext,
  recipient: ResolvedRecipient,
): RecipientClass {
  // Self check uses the live participant id (NOT the snapshot).
  if (callerContext.participantId === recipient.id) return 'self';

  if (recipient.kind === 'hivekeeper') {
    if (callerContext.kind === 'hivekeeper') {
      return 'other_hivekeeper'; // self handled above
    }
    // Sender is an agent.
    return callerContext.ownerId === recipient.id ? 'own_hivekeeper' : 'other_hivekeeper';
  }

  // Recipient is an agent (worker or scout).
  const recipientOwnerId = recipient.ownerId;
  if (recipientOwnerId === undefined) {
    // Recipient is an agent but the snapshot is missing ownerId — treat as
    // foreign owner (most restrictive). Engine will likely deny.
    return recipient.type === 'scout' ? 'other_owner_scout' : 'other_owner_worker';
  }

  let ownerEquals: boolean;
  if (callerContext.kind === 'hivekeeper') {
    // Hivekeeper sends to an agent — owner is the keeper themself.
    ownerEquals = callerContext.participantId === recipientOwnerId;
  } else {
    // Agent sends to an agent — owners match if they share the same Hivekeeper.
    ownerEquals = callerContext.ownerId === recipientOwnerId;
  }

  if (recipient.type === 'worker') {
    return ownerEquals ? 'own_worker' : 'other_owner_worker';
  }
  return ownerEquals ? 'own_scout' : 'other_owner_scout';
}
