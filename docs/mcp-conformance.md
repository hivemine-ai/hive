# MCP conformance

Hive runs the official MCP conformance suite, [`@modelcontextprotocol/conformance`](https://github.com/modelcontextprotocol/conformance), in CI (job `conformance` in `.github/workflows/pr.yml`).

- **Suite version:** `0.2.0-alpha.12` (the `alpha` dist-tag; the `latest` tag, `0.1.x`, predates the `2026-07-28` revision). It is pinned in `deployment/conformance/run.sh`.
- **Requirement set:** `--requirements 2026-07-28`, the scenarios the suite says that revision requires, run at that revision's stateless wire. Scenarios that only apply to older revisions (`initialize` handshake, sessions, `logging/setLevel`, `ping`, SSE polling) are not run, because Hive serves `2026-07-28` only and rejects the legacy protocol with `-32022` by design (ADR-024).

## Run it locally

The suite needs Node 22 or newer.

```bash
pnpm install && pnpm -r build
deployment/conformance/run.sh            # exit 0 when every failure is in the baseline
CONFORMANCE_OUTPUT_DIR=./results deployment/conformance/run.sh --verbose
```

The script creates a throwaway SQLite Hive in a temp directory (`hivectl init`), starts `hivectl serve` on `127.0.0.1:18443`, and removes everything on exit. The suite cannot send an `Authorization` header, so `deployment/conformance/auth-proxy.mjs` listens on `18444`, adds the admin Bearer to every request and forwards everything else untouched. `HIVE_MCP_ALLOWED_ORIGINS` is set to the proxy origin so the `dns-rebinding-protection` scenario can check that a loopback `Origin` is accepted. Override the ports with `CONFORMANCE_SERVER_PORT` and `CONFORMANCE_PROXY_PORT`.

## Result

104 checks pass and 68 are baselined failures (the totals count the not-scored extension scenarios too, which never decide the exit code). Passing, among others: `tools-list`, `resources-list`, `sep-2164-resource-not-found`, `server-sse-multiple-streams`, `dns-rebinding-protection`, `http-header-validation`, the 24 other `server-stateless` checks (`server/discover`, the `_meta` envelope, version and header rules) and the `caching` hints of `tools/list`.

## Known deviations

All are listed in `deployment/conformance/baseline.yml`. The runner fails if a baselined scenario starts passing (stale entry) and if anything else fails (regression).

| Group                                                                                                                                                                                                | Why                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tools-call-*`, `input-required-result-*` (fixture ones), `server-stateless` diagnostic-tool checks, `resources-read-*`, `resources-templates-read`, `missing-input-response`, `ignore-extra-params` | Fixture scenarios: they call tools and resources that exist only in the suite's reference server (`test_simple_text`, `test://static-text`, ...). Hive exposes its 8 messaging tools and one mailbox resource. Not a protocol error. |
| `prompts-*`, `caching:sep-2549-prompts-list-caching-hints`, `completion-complete`                                                                                                                    | Hive does not declare `prompts` or `completions` (see [MCP Server](mcp-server.md#protocol)); `Method not found` is the correct answer.                                                                                               |
| `caching:sep-2549-resources-templates-list-caching-hints`, `input-required-result-non-tool-request`                                                                                                  | Debatable, not fixed: Hive declares `resources` but serves no resource templates and answers `resources/templates/list` with `-32601`. Serving an empty list would be a design decision for a later PRY.                             |

Not scored and not baselined (they never fail the run): the `tasks-*` extension scenarios, `json-schema-2020-12` and `http-custom-header-server-validation`. Hive implements no Tasks extension, ships no tool with `x-mcp-header` annotations and has no `json_schema_2020_12_tool` fixture.

## Fixed because of this suite

- `resources/read` on a mailbox URI the caller does not own now echoes the URI in the error data (`data.uri`, SEP-2164). The code and message are unchanged and a foreign mailbox stays indistinguishable from a missing one.

## Upgrading the suite

Change `SUITE_VERSION` in `deployment/conformance/run.sh`, run it, and update `baseline.yml` for any scenario that was added or now passes. Read the requirement sets under `requirements/` in the npm package to see what a revision requires.
