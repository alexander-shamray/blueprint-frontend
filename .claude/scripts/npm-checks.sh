#!/usr/bin/env bash
# The local gate for /review-branch and /ship, with no free parameter: it replaces
# `Bash(npm run:*)` and `Bash(npx:*)`, which run whatever a manifest or a `--config` names,
# by fixing the script names and flags. It closes the executor and not the manifest:
# docs/harness-local.md, Residuals, owns that gap and why no mode runs the e2e suite.
set -euo pipefail

mode="${1:-all}"
root="$(git rev-parse --show-toplevel)"
cd "$root"

# An absent install checks main's packages, and passes: /branch forks inside the main
# checkout, and Node's module search and npm's PATH walk up out of a worktree into its
# node_modules. Presence only: an mtime test against package-lock.json refuses correct
# installs, because a checkout or rebase through another lockfile rewrites it unchanged.
[ -d node_modules ] ||
  { echo "no node_modules in $root — run npm ci here first" >&2; exit 3; }

case "$mode" in
  all)
    # The web job of .github/workflows/ci.yml, in its order. Lint first because
    # it is the cheapest and the most often red; build last because it is the
    # slowest and a type error has usually already surfaced in the tests.
    npm run lint
    npm test
    exec npm run build
    ;;
  fast)
    # Everything but the production build. `ng build` is the long pole, and it
    # re-typechecks what `ng test` has already compiled, so this is the mode for
    # a loop that runs on every edit.
    npm run lint
    exec npm test
    ;;
  lint)
    exec npm run lint
    ;;
  test)
    exec npm test
    ;;
  build)
    exec npm run build
    ;;
  *)
    echo "usage: npm-checks.sh [all|fast|lint|test|build]" >&2
    exit 2
    ;;
esac
