// Single source of truth for default HTTP listening port across the wire.
//
// The CLI boot banner, the wire bind logic, the http-host fastify default,
// and operator docs all consume this constant so the displayed bind matches
// the actual listening socket even when the operator does not set
// `HIVE_MCP_HTTP_PORT` or `--port`.
//
// Consumers across packages import from `@hive/shared` to avoid drift. See
// PRY-071 for the regression that motivated this consolidation: the CLI
// banner had a stale literal `'7700'` while the server defaults were
// `8443`, so the banner reported the wrong port at boot.
export const HIVE_DEFAULT_HTTP_PORT = 8443;

// Operator-facing safe default host shown in the CLI boot banner when no
// flag, env var, or config file value is supplied. NOT the same as the
// wire's programmatic default (`0.0.0.0`, see `composition/wire.ts`
// `resolveWireConfigFromEnv`): the wire's default exists for tests and
// programmatic embedding where "no host given → bind all" is the safest
// assumption, while the CLI default exists for operators who ran
// `hivectl init` without overriding the host (the safe choice is
// loopback-only — the operator opts into bind-all explicitly via
// `hivectl config network bind-all`). The two layers stay separate by
// design.
export const HIVE_DEFAULT_HTTP_HOST = '127.0.0.1';
