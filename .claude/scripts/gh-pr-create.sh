#!/usr/bin/env bash
# Open a pull request on THIS repository, from this branch, into main — and
# nothing else. `/pr`'s one create and `/ship`'s.
#
# **`Bash(gh pr create:*)` is a PREFIX grant and every one of the four things
# that decide what gets opened is a trailing flag (#16).**
# `gh pr create --repo <other> --head <other> --base <other> --body-file <other>`
# chooses a repository, a branch, a base and a body that are not the ones the
# command derived. All four are fixed here: the repository and the branch are
# read from the checkout, the base is the literal `main`, and the body is a
# file this script validates.
#
# **The body file is the one caller-supplied path, and it is where the leak
# would be.** `--body-file` makes `gh` read a file the session's own `Read`
# tool may be bounded away from and publish it — so the path is resolved and
# required to land inside this checkout or under the temp root, which are the
# two places a body is legitimately written. That is the same allow-list shape
# `guard-edit-target.py` uses for a write, applied to a read that publishes.
# A symbolic link is refused rather than followed, for the reason every other
# crossing in this directory refuses one.
#
# The title is passed as a value, never spliced, so a leading `-` in it is a
# title and not a flag.
set -euo pipefail
[ "$#" -eq 2 ] ||
  { echo "usage: gh-pr-create.sh <title> <body-file>" >&2; exit 2; }
title="$1"
body="$2"

[ -n "$title" ] || { echo "the title is empty" >&2; exit 2; }
# One line. A newline in a title is not a title, and `gh` would take the rest
# as body text with no indication in the report of what was sent.
case "$title" in *$'\n'*|*$'\r'*)
  echo "the title spans more than one line" >&2; exit 2 ;;
esac

[ -L "$body" ] &&
  { echo "the body file is a symbolic link: $body" >&2; exit 2; }
[ -f "$body" ] ||
  { echo "the body file is not a regular file: $body" >&2; exit 2; }

checkout=$(git rev-parse --show-toplevel) ||
  { echo "not inside a git checkout" >&2; exit 3; }
checkout=$(cd "$checkout" && pwd -P)
tmproot=$(cd "${TMPDIR:-/tmp}" 2>/dev/null && pwd -P) || tmproot=""
resolved=$(cd "$(dirname "$body")" && pwd -P)/$(basename "$body")
case "$resolved" in
  "$checkout"/*) ;;
  *) [ -n "$tmproot" ] && case "$resolved" in "$tmproot"/*) ;; *) false ;; esac ||
       { echo "the body file is outside this checkout and the temp root, and --body-file publishes what it reads: $resolved" >&2; exit 2; } ;;
esac

branch=$(git branch --show-current)
[ -n "$branch" ] || { echo "detached HEAD: there is no branch to open a PR for" >&2; exit 3; }
[ "$branch" != main ] ||
  { echo "refusing to open a pull request from main into main" >&2; exit 3; }

repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner) ||
  { echo "cannot resolve this checkout's repository" >&2; exit 3; }
[ -n "$repo" ] ||
  { echo "this checkout's repository resolved to nothing" >&2; exit 3; }

gh pr create --repo "$repo" --base main --head "$branch" \
  --title "$title" --body-file "$body"
