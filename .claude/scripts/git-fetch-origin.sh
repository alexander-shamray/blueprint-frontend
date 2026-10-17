#!/usr/bin/env bash
# Fetch ONE named branch from origin, and nothing else.
#
# `/ship` and `/branch` need exactly this and used to hold
# `Bash(git fetch origin:*)` for it. That grant pins the remote, so a URL never
# reaches the repository position, but it is a prefix grant and still admits a
# trailing flag: `--upload-pack`, `--receive-pack` and `--exec` were denied by
# name, and what was left was the flag nobody had enumerated yet
# (blueprint-frontend#114). A deny list cannot close that, because a flag can be
# abbreviated (`--upl=`) and the hook, not the rule, is what catches those.
#
# So: the remote is spelled here, the branch is the one argument, and its shape
# is checked before it reaches git. No flag can arrive looking like a name
# (a leading '-' is refused), no refspec can arrive looking like one (':' and
# '+' are outside the pattern), and a transport (`ext::<cmd>`) cannot arrive at
# all, because the argument is a ref name and the repository is `origin`.
set -euo pipefail

[ "$#" -eq 1 ] || { echo "usage: git-fetch-origin.sh <branch>" >&2; exit 2; }
branch="$1"

case "$branch" in
  -*) echo "branch name may not start with '-'" >&2; exit 2 ;;
  *..*) echo "branch name may not contain '..'" >&2; exit 2 ;;
esac
[[ "$branch" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] ||
  { echo "not a branch name this helper will take: $branch" >&2; exit 2; }

git fetch origin "$branch"
