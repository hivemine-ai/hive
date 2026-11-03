// Post-commit signal of a participant state change. It fires only inside the process
// that performed the change: `hivectl` is another process, and streams find out about
// its changes through `reverifyStream`.

import type { Logger } from '#observability/logger.js';

import type { UUIDv7 } from '../types.js';

export interface ParticipantStateChange {
  participantId: UUIDv7;
  newState: 'active' | 'suspended' | 'revoked';
}

export type ParticipantStateListener = (change: ParticipantStateChange) => void;

export interface ParticipantStateSignal {
  emit(change: ParticipantStateChange): void;
  onParticipantStateChanged(listener: ParticipantStateListener): () => void;
}

export function createParticipantStateSignal(
  deps: { logger?: Logger } = {},
): ParticipantStateSignal {
  const listeners = new Set<ParticipantStateListener>();

  return {
    // Best-effort: the admin operation is already committed, so a failing listener is
    // logged and neither reverts it nor reaches the other listeners.
    emit(change) {
      for (const listener of Array.from(listeners)) {
        try {
          listener(change);
        } catch (err) {
          deps.logger?.warn(
            {
              event: 'auth_state_listener_failed',
              participantId: change.participantId,
              newState: change.newState,
              err: err instanceof Error ? err.message : String(err),
            },
            'participant state listener threw',
          );
        }
      }
    },

    onParticipantStateChanged(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
