// Single source of truth for the Hive release version.
//
// The default value is the local development sentinel `'0.1.0-dev'`. The
// `release.yml` workflow's `Sync release version to source` step rewrites
// this string to the release version (e.g. `'0.1.0'`) before `pnpm build`
// + SEA bundle, so the published binaries report the actual release tag
// in `hivectl --version`, audit log entries, MCP server-info, and the
// status snapshot.
//
// Consumers across packages import from `@hive/shared` to avoid drift.
// See PRY-060 for the rationale and the regression that motivated this
// consolidation.
export const HIVE_VERSION = '0.1.0-dev';
