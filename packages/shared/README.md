# @hive/shared

> Shared types and constants used across `@hive/server`, `@hive/cli`, and `@hive/client`.

## Purpose

A leaf package with no runtime side effects. It exists to break import cycles and to publish a stable contract for cross-package values that don't belong to a single domain (e.g. wire format constants, MCP tool name registry).

> **Status (v0.1):** intentionally empty. Each PRY adds shared declarations as cross-package needs surface.

## License

Apache-2.0. See [NOTICE](../../NOTICE).
