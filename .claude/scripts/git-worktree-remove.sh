#!/usr/bin/env bash
# Remove the sibling worktree `/branch` step 5 forked, and nothing else.
#
# **`Bash(git worktree remove:*)` is a PREFIX grant, so a trailing `-f` is
# inside it (#16)** — and `-f` is precisely the refusal that matters here.
# `ship.md` step 8 relies on `git worktree remove` declining a dirty worktree:
# that refusal is what stops the teardown from deleting work the run did not
# commit, and the step's own text says the directory is left for inspection
# when it fires. A grant that admits the flag which defeats it leaves the
# guarantee resting on the model not typing three characters.
#
# The path shape is `git-worktree-fork.sh`'s, because the fork is the only
# thing that creates what this removes: a sibling of the checkout, `../<name>`.
# Neither the sweeps' detached worktrees nor anything else reaches this —
# `git-worktree-drop.sh` owns those, with its own shape check.
set -euo pipefail
[ "$#" -eq 1 ] || { echo "usage: git-worktree-remove.sh <path>" >&2; exit 2; }
path="$1"

# The same grammar the fork helper writes with, so nothing can be removed that
# this repository's own commands did not create — and neither `-f` nor any
# other flag can arrive, since the argument cannot begin with `-`.
[[ "$path" =~ ^\.\./[A-Za-z0-9][A-Za-z0-9._-]*$ ]] ||
  { echo "path must be a sibling of the checkout: ../<name>" >&2; exit 2; }
[ -d "$path" ] || { echo "no such directory: $path" >&2; exit 3; }

# It must be a worktree of THIS repository, not merely a sibling directory
# with the right name. `git worktree list` is the register; a path absent from
# it is something else, and removing it is not this helper's business.
resolved=$(cd "$path" && pwd -P)
registered=$(git worktree list --porcelain | sed -n 's/^worktree //p')
found=no
# Read in THIS shell, not through a pipe: a `while` on the right of a pipe runs
# in a subshell, so a flag set inside it is lost and the check would answer
# `no` on every path — refusing the teardown it exists to permit.
while IFS= read -r line; do
  [ -n "$line" ] && [ -d "$line" ] || continue
  [ "$(cd "$line" && pwd -P)" = "$resolved" ] && found=yes
done <<<"$registered"
[ "$found" = yes ] ||
  { echo "not a worktree of this repository: $resolved" >&2; exit 3; }

# No `--force`. The refusal on a dirty worktree is the point of this endpoint,
# and `ship.md` step 8 reports the directory as left for inspection when it
# fires rather than treating it as an error to get past.
git worktree remove "$path"
