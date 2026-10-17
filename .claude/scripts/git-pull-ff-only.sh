#!/usr/bin/env bash
# Fast-forward the CURRENT branch from origin, and nothing else.
#
# `/ship` held `Bash(git pull --ff-only)` — no `:*`, so meant as the
# no-argument invocation only. Whether an allow rule without a wildcard is
# still a prefix match was never measured, and the probe cannot be run from
# inside a session (`docs/harness-boundaries.md`), so the grant was "narrowed,
# not proven" and `git pull --ff-only ext::<cmd>` was the question
# (blueprint-frontend#114). This file makes the answer not matter: the grant is
# now this script, which takes no argument at all, spells the remote itself and
# names the branch from the checkout, so there is no position left for a
# transport or a flag to occupy.
#
# `--ff-only` is spelled here, which is what keeps a diverged branch a refusal
# rather than a merge commit this repository stopped making.
set -euo pipefail

[ "$#" -eq 0 ] || { echo "takes no argument: it pulls the current branch from origin" >&2; exit 2; }

branch=$(git branch --show-current)
[ -n "$branch" ] || { echo "detached HEAD: there is no branch to fast-forward" >&2; exit 4; }

# A branch name already in the checkout passed git's own checks, so this is
# the shape the other helpers hold their arguments to, applied to a value this
# file read rather than was handed.
case "$branch" in
  -*) echo "branch name may not start with '-'" >&2; exit 2 ;;
  *..*) echo "branch name may not contain '..'" >&2; exit 2 ;;
esac
[[ "$branch" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] ||
  { echo "not a branch name this helper will take: $branch" >&2; exit 2; }

git pull --ff-only origin "$branch"
