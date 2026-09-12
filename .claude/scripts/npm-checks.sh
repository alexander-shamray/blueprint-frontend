#!/usr/bin/env bash
# The local gate for /review-branch and /ship, with no free parameter anywhere.
#
# It replaces `Bash(npm run:*)` and `Bash(npx:*)`, both of which are grants far
# wider than the operation the commands name. `npm run <name>` executes whatever
# `package.json` says under that name — including a script a session may
# legitimately have just written — and `npm test -- <args>` forwards its tail to
# Vitest, which takes `--config <path>` and EXECUTES that file to load it. Either
# one turns "run the tests" into "run this". So the script names and the flag
# sets are fixed here, and the only variable is one word out of a closed set.
#
# **This closes the executor and not the manifest.** `package.json` is still a
# file the session can edit, and every mode below runs whatever its `scripts`
# block currently says — so the manifest itself has to be out of reach, which is
# `disallowed-tools`' job in review-branch.md rather than this script's. The same
# holds for the config files those scripts read (`angular.json`,
# `eslint.config.js`, `vitest` config) and for `node_modules/.bin`.
#
# `e2e` is deliberately NOT one of the modes. Playwright needs a browser
# download and the backend's Compose stack on :5000, neither of which exists in
# the sandbox the external reviewer runs in; a mode that silently passed because
# nothing was listening would be worse than no mode at all. E2E is CI's job — see
# the `e2e` job in .github/workflows/ci.yml — and `docs/testing.md` says what a
# local run needs.
set -euo pipefail

mode="${1:-all}"
root="$(git rev-parse --show-toplevel)"
cd "$root"

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
