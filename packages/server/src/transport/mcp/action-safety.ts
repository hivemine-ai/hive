// F-S3 hardening from PRY-003 security review (recogido en PRY-006 Notas):
// Cell Store does NOT deserialise `action` (treats it as opaque, validates only
// size). The MCP read_mailbox tool is the first point where the client receives
// the action body. Deeply-nested but small JSON can stack-overflow naive
// recursive parsers / consumers. We re-validate depth before exposing.
//
// 32 levels is generous for legitimate `action` payloads (RFC 7807 Problem
// Details, JSONPath expressions, etc. nest at most ~5-10 levels). Reject
// beyond as defense-in-depth.

import { CellError } from '#domain/cells/index.js';

export const MAX_ACTION_DEPTH = 32;

/**
 * Returns the value if its JSON depth is within the limit; throws
 * `CellError('INVALID_INPUT', { subCode: 'action_too_deep' })` otherwise.
 *
 * Iterative DFS — no recursion, so the depth check itself is stack-safe.
 */
export function ensureSafeAction(value: unknown, maxDepth: number): unknown {
  if (depthOf(value) > maxDepth) {
    throw new CellError('INVALID_INPUT', { subCode: 'action_too_deep' });
  }
  return value;
}

function depthOf(value: unknown): number {
  if (value === null || typeof value !== 'object') return 0;

  // Iterative DFS using an explicit stack of [node, depth] pairs.
  const stack: Array<[unknown, number]> = [[value, 1]];
  let maxSeen = 1;

  while (stack.length > 0) {
    const next = stack.pop();
    if (!next) break;
    const [node, depth] = next;

    if (depth > maxSeen) maxSeen = depth;

    if (Array.isArray(node)) {
      for (const item of node) {
        if (item !== null && typeof item === 'object') {
          stack.push([item, depth + 1]);
        }
      }
    } else if (node !== null && typeof node === 'object') {
      for (const key of Object.keys(node)) {
        const child = (node as Record<string, unknown>)[key];
        if (child !== null && typeof child === 'object') {
          stack.push([child, depth + 1]);
        }
      }
    }
  }

  return maxSeen;
}
