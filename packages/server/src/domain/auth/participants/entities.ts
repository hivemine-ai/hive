// Domain entities for participants. Persistence rows are mapped to/from these by the
// repository layer; the rest of the domain consumes only these types.

import type { ParticipantState, UUIDv7 } from '../types.js';

export interface Hive {
  id: UUIDv7;
  name: string;
  createdAt: Date;
}

export interface Colony {
  id: UUIDv7;
  hiveId: UUIDv7;
  name: string;
  createdAt: Date;
}

export interface Hivekeeper {
  id: UUIDv7;
  hiveId: UUIDv7;
  colonyId: UUIDv7;
  email: string;
  displayName: string | null;
  isAdmin: boolean;
  state: 'active' | 'revoked';
  createdAt: Date;
  revokedAt: Date | null;
}

export interface Agent {
  id: UUIDv7;
  hiveId: UUIDv7;
  colonyId: UUIDv7;
  ownerId: UUIDv7;
  name: string;
  type: 'worker' | 'scout';
  capabilities: string[];
  instructions: string;
  state: ParticipantState;
  createdAt: Date;
  revokedAt: Date | null;
}

/**
 * Polymorphic union returned by `participantsRepo.findById(sub)`. The discriminator is the
 * `kind` field; `'hivekeeper'` carries a `Hivekeeper`, `'agent'` carries an `Agent`.
 */
export type Participant =
  | { kind: 'hivekeeper'; hivekeeper: Hivekeeper }
  | { kind: 'agent'; agent: Agent };

/**
 * Minimal projection used by the verifier (step 6/7) and pre-condition checks. Avoids
 * loading every column when only the discriminator + state + admin flag matter.
 */
export interface ParticipantStateSummary {
  kind: 'hivekeeper' | 'worker' | 'scout';
  state: ParticipantState;
  isAdmin: boolean | null;
  hiveId: UUIDv7;
  colonyId: UUIDv7;
  ownerId: UUIDv7 | null;
}
