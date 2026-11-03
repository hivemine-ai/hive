// F-S3 hardening from the PRY-003 security review. Deeply nested but small JSON
// can stack-overflow naive recursive parsers and consumers, so `action` is
// bounded by depth as well as by size.
//
// The limit is enforced on write, so a message that can be stored can always be
// read. The read path re-checks it for rows written before this validation.
//
// 32 levels is generous for legitimate `action` payloads (RFC 7807 Problem
// Details, JSONPath expressions, etc. nest at most ~5-10 levels).

import { CellError } from './errors.js';

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
