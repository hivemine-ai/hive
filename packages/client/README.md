# @hive/client

> Reusable client library for Hive (Node.js).

## Purpose

Wraps the official 2.x MCP client SDK (protocol revision `2026-07-28`) with the pieces `hivectl watch` needs: a reconnecting `subscriptions/listen` loop, a silence detector that measures raw bytes, a strict event schema, and a one-shot `check_unread_messages` query. It carries no message bodies and persists nothing.

It does not include a general-purpose Hive SDK or bearer-credential storage; it is consumed by `@hive/cli` today.

## Public API

- `runListenLoop`, `createSdkConnector`, `createRuntimeDeps` — the reconnecting listen core and its real transport.
- `checkUnread` — one `check_unread_messages` call.
- `parseWaggleMeta`, `parseUnreadSummary`, `buildQueryEvent`, `serializeEventLine`, `WatchEvent` — the event schema (`eventId`, `senders`, `count`).
- `backoffDelay`, `AuthRetryWindow` — backoff and the bounded retry window for rejected credentials.
- `ListenError` — typed failures (`auth_rejected`, `protocol_unsupported`, `transport`).
- `@hive/client/testing` — `startFakeHiveServer`, a stand-in Hive edge built on the 2.x server SDK, for tests only.

See [`docs/hivectl-watch.md`](../../docs/hivectl-watch.md) for the user-facing behaviour.

## License

Apache-2.0. See [NOTICE](../../NOTICE).
