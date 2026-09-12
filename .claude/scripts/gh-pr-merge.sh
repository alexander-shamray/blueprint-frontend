#!/usr/bin/env bash
# Merge one of THIS repository's pull requests with a merge commit, bound to a
# named head, and nothing else — `/ship` step 7's one merge and no other.
#
# **`Bash(gh pr merge --merge:*)` is a PREFIX grant, so a trailing flag is
# inside it (#16).** `gh pr merge --merge <n> --admin` bypasses the failing-check
# stop that step 7 treats as mandatory: a pull request merged past red checks by
# a chain whose report says the checks gated it. `ship.md` argues this at length
# and what stood was visibility rather than prevention — step 7 reports the
# literal invocation it ran, so the claim is checkable rather than enforced.
#
# It also explains why a session could not simply write this helper: a session
# able to add `.claude/scripts/gh-pr-merge.sh` could also edit the one it is
# about to invoke, which would make every fixed endpoint in the chain a
# fiction. So this arrives as a human's change to a reviewed file, with the
# raw grant withdrawn in the same commit, which is the only way it means
# anything.
#
# **`--match-head-commit` is a required ARGUMENT here, not an optional flag.**
# `ship.md` calls it "the only guard in this step that fails closed" and then
# relied on prose to make it present. Without it the green verdict and the
# merge are two reads of a moving target: a push landing between them merges a
# commit whose checks never ran. A helper that can be called without it is a
# helper that will be.
#
# The method is fixed to `--merge`, which is this repository's shape — every
# entry in `git log --merges` reads `Merge pull request #n from …`. `--squash`
# discards what `/commit` and `/pr` spend their effort producing, and is not a
# choice this endpoint offers.
set -euo pipefail
[ "$#" -eq 2 ] ||
  { echo "usage: gh-pr-merge.sh <pr-number> <head-oid>" >&2; exit 2; }
pr="$1"
oid="$2"
[[ "$pr" =~ ^[0-9]+$ ]] || { echo "pr must be a number: $pr" >&2; exit 2; }
[[ "$oid" =~ ^[0-9a-f]{40}$ ]] ||
  { echo "head oid must be a full 40-character sha: $oid" >&2; exit 2; }

# The repository is resolved from the checkout, never accepted, so `--repo`
# cannot be aimed elsewhere by anything a body or a review said. Blank counts
# as missing: `gh` printing an empty string exits 0, and an empty `--repo`
# would fall back to whatever the checkout resolves to at merge time.
repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner) ||
  { echo "cannot resolve this checkout's repository" >&2; exit 3; }
[ -n "$repo" ] ||
  { echo "this checkout's repository resolved to nothing" >&2; exit 3; }

gh pr merge --merge --repo "$repo" --match-head-commit "$oid" "$pr"
