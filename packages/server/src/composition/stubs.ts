// Composition-root stubs for collaborators that are not yet implemented.
//
// The `VisibilityEngine` interface itself lives in `domain/cells/visibility-engine.ts`
// so that `cells/send.ts` and downstream consumers depend on a neutral, intra-domain
// contract instead of reaching into the composition root. PRY-008 (Visibility Engine)
// will swap `stubVisibilityEngine` for the real implementation here.

import type { VisibilityEngine } from '#domain/cells/index.js';

// Stub for B0; replaced in PRY-008 (Visibility Engine).
export const stubVisibilityEngine: VisibilityEngine = {
  canSend(): Promise<boolean> {
    return Promise.resolve(true);
  },
  canSee(): Promise<boolean> {
    return Promise.resolve(true);
  },
};

// Re-export so existing callers that import from `#composition/stubs.js`
// continue to compile without changes.
export type { VisibilityEngine } from '#domain/cells/index.js';
