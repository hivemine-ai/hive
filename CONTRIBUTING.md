# Contributing to Hive

Thank you for your interest in contributing. Hive is in early development (v0.1) and the contribution flow is intentionally lightweight.

## Code of Conduct

This project adopts the [Contributor Covenant 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/). By participating you agree to abide by its terms.

## Development setup

You need:

- [Node.js](https://nodejs.org/) — version is pinned in [`.nvmrc`](./.nvmrc). With [nvm](https://github.com/nvm-sh/nvm): `nvm use`.
- [pnpm](https://pnpm.io/) — version is pinned in the root `package.json` `packageManager` field. With Corepack enabled (`corepack enable`), the right version is used automatically.
- PostgreSQL 16+ for integration work (not required to typecheck or lint).

Install and validate:

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
```

## Commit conventions

We use [Conventional Commits](https://www.conventionalcommits.org/) with a package scope:

```
<type>(<scope>): <subject>
```

- **Types:** `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`, `build`, `ci`.
- **Scopes:** `server`, `cli`, `client`, `shared`, `repo` (root), `deployment`, `docs`.
- **Subject:** imperative mood, no trailing period.

Examples:

```
feat(server): add createHivekeeper handler
chore(repo): bootstrap mono-repo skeleton
test(shared): cover audit log indexer edge cases
```

When pair-programming with Claude (or other AI assistants), include a `Co-Authored-By` trailer in the commit body — this is a project convention from day one.

## Pull request workflow

1. Branch from `main` using a `pry/PRY-NNN-<slug>` name when working on a tracked PRY, or `feat/`, `fix/`, `chore/`, `docs/`, `refactor/` otherwise.
2. Keep PRs focused. Prefer rebase over merge commits to keep history linear.
3. CI must be green (`typecheck` + `lint` + `test`) before merging.
4. Update `CHANGELOG.md` under `[Unreleased]` when the change is user-visible.

## Running checks before pushing

A pre-commit hook (husky + lint-staged) formats and lints staged files automatically. Do not bypass with `--no-verify`; if a hook fails, fix the underlying issue.

## Reporting issues

- **Bug:** open an issue with the `bug` template — include reproduction steps and your environment.
- **Feature request:** open an issue with the `feature` template — describe the use case before proposing an implementation.

## Security

Do not file security reports as public issues. Email the maintainers (contact published when v0.1.0 ships) or open a GitHub Security Advisory privately.
