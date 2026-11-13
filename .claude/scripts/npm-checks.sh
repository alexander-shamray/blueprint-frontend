#!/usr/bin/env bash
# The local gate for /review-branch and /ship, with no free parameter: it replaces
# `Bash(npm run:*)` and `Bash(npx:*)`, which run whatever a manifest or a `--config` names,
# by fixing the script names and flags. It closes the executor and not the manifest:
# docs/harness-local.md, Residuals, owns that gap and why no mode runs the e2e suite.
set -euo pipefail

mode="${1:-all}"
# Absolute before the cd below: a relative call from a subdirectory would otherwise
# look for the recorder beside the repository root's copy of this path.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(git rev-parse --show-toplevel)"
cd "$root"

# An absent install checks main's packages, and passes: /branch forks inside the main
# checkout, and Node's module search and npm's PATH walk up out of a worktree into its
# node_modules. Presence only: an mtime test against package-lock.json refuses correct
# installs, because a checkout or rebase through another lockfile rewrites it unchanged.
[ -d node_modules ] ||
  { echo "no node_modules in $root — run npm ci here first" >&2; exit 3; }

# Each mode keeps the failing command's own status: the run's exit is its checks',
# never its record's, so the record below can neither mask nor invent a failure.
started=$SECONDS
status=0
case "$mode" in
  all)
    # The web job of .github/workflows/ci.yml, in its order. Lint first because
    # it is the cheapest and the most often red; build last because it is the
    # slowest and a type error has usually already surfaced in the tests.
    label=all
    { npm run lint && npm test && npm run build; } || status=$?
    ;;
  fast)
    # Everything but the production build. `ng build` is the long pole, and it
    # re-typechecks what `ng test` has already compiled, so this is the mode for
    # a loop that runs on every edit.
    label=fast
    { npm run lint && npm test; } || status=$?
    ;;
  lint)
    label=lint
    npm run lint || status=$?
    ;;
  test)
    label=test
    npm test || status=$?
    ;;
  build)
    label=build
    npm run build || status=$?
    ;;
  *)
    echo "usage: npm-checks.sh [all|fast|lint|test|build]" >&2
    exit 2
    ;;
esac

# One line of how long the run took, for harness_timings.py report
# (docs/harness-boundaries.md, *The suite's shard runner*). A failed record is
# said by the recorder and swallowed here; a machine with no Python records nothing.
timings="$here/harness_timings.py"
if command -v py >/dev/null 2>&1; then
  interpreter=(py -3.12)
elif command -v python3 >/dev/null 2>&1; then
  interpreter=(python3)
else
  interpreter=(python)
fi
"${interpreter[@]}" "$timings" record --script npm-checks.sh --mode "$label" \
  --wall "$((SECONDS - started))" --exit "$status" || true
exit "$status"
