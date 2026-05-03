// Handler for `hivectl` invoked with no subcommand. Tiny wrapper that
// reads the status snapshot, renders the cold-start frame, and writes
// to stdout. The whole point of staying tiny: the latency budget is
// <50ms warm / <30ms cold (no snapshot) per the [[hivectl Output Layer
// + Status Snapshot]] tech spec § Slice 2 + the product spec
// [[hivectl — Operator Experience]] § Cold start. Anything that
// touches the network here would also break the AC `strace` /
// `lsof` smoke checks, so importing the runtime, the commander tree,
// or any DB/HTTP module is forbidden.

import { renderColdStart } from '#output/cold-start.js';
import { readSnapshot } from '#state/snapshot.js';

/**
 * Read the on-disk snapshot (or null if absent / malformed) and render
 * the cold-start frame to stdout. Returns nothing; never throws —
 * `readSnapshot` already swallows I/O errors and returns null with an
 * stderr warn, and `renderColdStart` is a pure function.
 */
export async function runColdStart(): Promise<void> {
  const snap = await readSnapshot();
  process.stdout.write(renderColdStart(snap));
}
