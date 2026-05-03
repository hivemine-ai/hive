# @hive/shared

> Shared types and constants used across `@hive/server`, `@hive/cli`, and `@hive/client`.

## Purpose

A leaf package with no runtime side effects. It exists to break import cycles and to publish a stable contract for cross-package values that don't belong to a single domain. New entries land here only when at least two consumer packages need the same declaration — single-consumer values stay in their owning package.

## Public API

- **`HiveStatusSnapshot`** — interface for the sidecar JSON written by the server and read by the CLI cold start. Schema is versioned (`v: 1`); future incompatible changes bump `v` and the older reader treats unknown versions as missing per ADR-022 contract.
- **`snapshotPath()`** — XDG state path resolver (`XDG_STATE_HOME` env honoured; falls back to `~/.local/state/hive/status.json`).
- **`isStale(snap, now?)`** — `(now - writtenAt) > 2 × heartbeatSeconds` policy. Negative skew (snapshot from the "future") treated as fresh; malformed `writtenAt` treated as stale.
- **`atomicWriteJson(path, data)`** — sync write to `<path>.tmp` + `renameSync`; atomic on POSIX and NTFS modern. Creates parent directories if missing.

See [`docs/hivectl.md`](../../docs/hivectl.md) § Status snapshot for the operator-facing description.

## License

Apache-2.0. See [NOTICE](../../NOTICE).
