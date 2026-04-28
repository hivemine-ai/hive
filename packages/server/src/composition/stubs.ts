// Composition-root stubs for collaborators that are not yet wired by default.
//
// The `VisibilityEngine` interface itself lives in `domain/visibility/types.ts`
// (PRY-004). The stub below is preserved because PRY-003's domain unit tests
// inject it to bypass the real engine; the composition root of the server uses
// the real engine constructed by the visibility factory (PRY-004 milestone 8).

import type { VisibilityEngine } from '#domain/visibility/index.js';

/**
 * Always-allow stub. Use ONLY in domain unit tests of Cell Store that need a
 * trivial engine. Production code paths must use the real engine wired by
 * `composition/visibility-engine-factory.ts`.
 */
export const stubVisibilityEngine: VisibilityEngine = {
  canSend(): Promise<boolean> {
    return Promise.resolve(true);
  },
  canSee(): Promise<boolean> {
    return Promise.resolve(true);
  },
};
