# Platform packages

This directory holds the template used by `release.yml` to generate the three
platform-scoped binary packages that back `@hivemine/hivectl` in v0.1.0:

- `@hivemine/hivectl-linux-x64`
- `@hivemine/hivectl-linux-arm64`
- `@hivemine/hivectl-darwin-arm64`

`darwin-x64` (Intel Mac) is intentionally absent in v0.1.0 — see
`CHANGELOG.md` for the GitHub Actions runner rationale. Intel Mac users
install the `linux-x64` binary via Rosetta 2; the wrapper's `install.js`
emits an actionable warning when it sees `darwin x64`.

The release workflow instantiates `package.json.template` per matrix job by
substituting `{{PLATFORM_NAME}}`, `{{VERSION}}`, `{{OS}}`, `{{CPU}}`, copies
the freshly built SEA `hivectl` binary into `bin/`, and runs
`npm publish --access public`.

Each platform package declares `better-sqlite3` as a dependency so npm
materialises the prebuilt native binding next to the binary on install
(SEA's bundled `require` falls back to standard Node module resolution from
the binary's directory, so the binding must be reachable on disk). `pg` is
declared optional — only Postgres opt-in deployments install it.
