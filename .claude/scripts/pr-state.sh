#!/usr/bin/env bash
# Read a PR's merge-relevant state as JSON — /ship's only `gh pr view` route.
# Read-only, fixed field set.
#
# **Exists so that ship.md need not hold `Bash(gh pr view:*)` (#56)**, the
# grant that reaches `--json reviews` and `--json comments` unfiltered: text
# anyone can post, read on a run nobody is watching.
#
# The field set is the union of the three reads ship.md performs — the resume
# table's `state`, step 6's pre-merge check, and step 6's post-merge
# confirmation. One fixed set rather than a parameter, for the reason every
# helper here fixes its endpoint: a caller that chooses fields can choose
# `reviews`.
set -euo pipefail
pr="${1:?usage: pr-state.sh <pr-number>}"
[[ "$pr" =~ ^[0-9]+$ ]] || { echo "pr must be a number" >&2; exit 2; }
gh pr view "$pr" --json state,mergeable,mergeStateStatus,headRefOid,mergeCommit
