#!/bin/sh
# Runs Claude Code's own plugin validator on packages/claude-plugin. Part of the
# smoke because the CI runners do not ship the `claude` CLI. The validator has
# rules of its own for mods (for example, `$` may only be passed to functions
# declared at the top level of the module) that the unit tests cannot see.
set -eu
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
claude plugin validate "$REPO/packages/claude-plugin"
