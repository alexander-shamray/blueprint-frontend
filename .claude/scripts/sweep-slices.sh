#!/usr/bin/env bash
# Cut a sweep's worktree into slices of at most BUDGET bytes, one list per slice
# beside the worktree, and print a summary; /bug-sweep and /security-sweep.
# The row partition is the sweeps' and lives here, so a tracked path no row owns
# refuses the run rather than going unswept.
#
# Ported from blueprint-backend's helper of the same name (blueprint-frontend
# #172), with this tree's rows and for bash 3.2, which is what macOS ships as
# /bin/bash and where `mapfile` and associative arrays do not exist: the
# classification is one awk pass over three newline lists.
set -euo pipefail
usage="usage: sweep-slices.sh <bug|security> <worktree> [full]"
[ "$#" -ge 2 ] && [ "$#" -le 3 ] || { echo "$usage" >&2; exit 2; }
kind="$1" path="$2" mode="${3:-}"
case "$kind" in bug|security) : ;; *) echo "$usage" >&2; exit 2 ;; esac
case "$mode" in ''|full) : ;; *) echo "$usage" >&2; exit 2 ;; esac
case "$path" in -*) echo "path may not start with '-'" >&2; exit 2 ;; esac
[ -d "$path" ] || { echo "not an existing directory: $path" >&2; exit 2; }
BUDGET=240000

# The shape git-worktree-detach.sh makes and git-worktree-drop.sh requires, so
# the one directory this writes is the sweep's own and never a caller's choice.
tmproot=$(cd "${TMPDIR:-/tmp}" 2>/dev/null && pwd -P) ||
  { echo "cannot resolve the temp root" >&2; exit 4; }
resolved=$(cd "$path" && pwd -P)
[ "$(dirname "$resolved")" = "$tmproot" ] ||
  { echo "not a direct child of the temp root: $path" >&2; exit 2; }
case "$(basename "$resolved")" in
  secsweep-??????) : ;;
  *) echo "not a sweep-shaped temp path: $path" >&2; exit 2 ;;
esac
out="$resolved.slices"
[ ! -e "$out" ] || { echo "slices already cut: $out" >&2; exit 3; }

g() { git -C "$resolved" "$@"; }
pinned=$(g rev-parse --verify HEAD)
since=""
if [ "$mode" != full ] && last=$(g rev-parse --verify --quiet "refs/sweeps/$kind^{commit}"); then
  # A ref that is not an ancestor marks a sweep of another line of history, so
  # the diff from it would skip files this commit never had swept.
  if g merge-base --is-ancestor "$last" "$pinned"; then since="$last"; fi
fi

# The bytes inside fences, the only part of a sample the sweeps audit. A fence
# closes only on its own character, at least as long, with nothing after it.
fenced_bytes() {
  awk '
    match($0, /^[ \t]*(```+|~~~+)/) {
      mark = substr($0, RSTART, RLENGTH); sub(/^[ \t]*/, "", mark)
      ch = substr(mark, 1, 1); n = length(mark); rest = substr($0, RSTART + RLENGTH)
      if (!open) { open = 1; och = ch; on = n; next }
      if (ch == och && n >= on && rest ~ /^[ \t]*$/) { open = 0; next }
    }
    open { total += length($0) + 1 }
    END { print total + 0 }'
}

# A NUL-separated list as one name a line. A name holding a line break cannot
# be a line of a list, and refusing it is the only answer that does not drop it
# unsaid: the NULs counted before must equal the lines counted after.
lines_of() {
  local nuls lines
  nuls=$(tr -cd '\0' < "$1" | wc -c)
  tr '\0' '\n' < "$1" > "$2"
  lines=$(wc -l < "$2")
  [ $((lines)) -eq $((nuls)) ] ||
    { echo "a tracked name with a line break" >&2; exit 3; }
}

# Each git read lands in a file with its status checked, NUL-separated, so a
# failing git fails the run and a name holding a newline stays one name.
mkdir "$out"
# Any exit before the plan is printed takes the half-cut lists with it.
trap 'rm -rf "$out"' EXIT
g ls-tree -r -l -z --full-tree "$pinned" > "$out/tree.z"
g grep -I -l -z -e '' "$pinned" -- . > "$out/text.z" || [ "$?" -eq 1 ]
: > "$out/changed.z"
[ -z "$since" ] || g diff --name-only --no-renames -z "$since" "$pinned" > "$out/changed.z"
lines_of "$out/tree.z" "$out/tree.txt"
lines_of "$out/text.z" "$out/text.raw"
lines_of "$out/changed.z" "$out/changed.txt"
sed "s/^[0-9a-f]*://" "$out/text.raw" > "$out/text.txt"
[ -s "$out/tree.txt" ] || { echo "no tracked files at $pinned" >&2; exit 3; }
# A tab or a carriage return in a name would split or trim a list line, and
# `git ls-tree` puts exactly one tab between the metadata and the name.
[ $(($(tr -cd '\r' < "$out/tree.txt" | wc -c))) -eq 0 ] &&
  awk -F'\t' 'NF != 2 { bad = 1 } END { exit bad }' "$out/tree.txt" ||
  { echo "a tracked name with a tab or a carriage return" >&2; exit 3; }

# The rows. A path no row owns is printed on stderr and counted, and the run
# refuses below; the other lines are `L row size file` for what the sweep reads.
#   bug       core screens suites tooling native samples
#   security  source tooling native samples
awk -F'\t' -v kind="$kind" -v since="$since" '
  function row_of(f,   top) {
    if (index(f, "/") == 0) return "native"
    top = f; sub(/\/.*/, "", top)
    if (top == ".github" || top == ".claude" || top == ".vscode" || top == "tools") return "tooling"
    if (top == "android" || top == "ios") return "native"
    if (top == "docs") return "samples"
    if (kind == "security") {
      if (top == "src" || top == "e2e" || top == "public") return "source"
      return ""
    }
    if (top == "e2e") return "suites"
    if (top == "src") {
      if (f ~ /\.spec\.ts$/) return "suites"
      if (f ~ /^src\/app\/core\//) return "core"
      return "screens"
    }
    if (top == "public") return "screens"
    return ""
  }
  FILENAME == ARGV[1] { text[$0] = 1; next }
  FILENAME == ARGV[2] { changed[$0] = 1; next }
  {
    tracked++
    file = $2; n = split($1, meta, " "); size = meta[n]
    if (size !~ /^[0-9]+$/) size = 0
    row = row_of(file)
    if (row == "") { print "no row owns: " file > "/dev/stderr"; unowned++; next }
    if (since != "" && !(file in changed)) { unchanged++; next }
    if (size == 0) { empty++; next }
    if (!(file in text)) { binary++; next }
    # Closed records are never edited to match the code, so a defect in their
    # samples has no fix to file; owned by the row, counted, not read.
    if (file ~ /^docs\/superpowers\//) { record++; next }
    printf "L\t%s\t%s\t%s\n", row, size, file
  }
  END { printf "T\t%d\t%d\t%d\t%d\t%d\t%d\n", tracked, unowned, unchanged, empty, binary, record }
' "$out/text.txt" "$out/changed.txt" "$out/tree.txt" > "$out/plan.raw"

totals=$(grep '^T' "$out/plan.raw")
IFS=$'\t' read -r _ tracked unowned unchanged empty binary record <<<"$totals"
[ "$unowned" -eq 0 ] || { echo "$unowned tracked path(s) no row owns" >&2; exit 3; }

# A sample counts only its fenced lines; one with none is counted, not listed.
fenceless=0
: > "$out/plan.rows"
while IFS=$'\t' read -r tag row size file; do
  [ "$tag" = L ] || continue
  if [ "$row" = samples ]; then
    size=$(g cat-file blob "$pinned:$file" | fenced_bytes)
    [ "$size" -gt 0 ] || { fenceless=$((fenceless + 1)); continue; }
  fi
  printf '%s\t%s\t%s\n' "$row" "$size" "$file" >> "$out/plan.rows"
done < "$out/plan.raw"
listed=$(($(wc -l < "$out/plan.rows")))
if [ -z "$since" ] && [ "$listed" -eq 0 ]; then
  echo "a full run that lists nothing has read nothing" >&2; exit 3
fi
# A stable sort by row keeps each row's files in tree order.
sort -t$'\t' -k1,1 -s "$out/plan.rows" > "$out/plan.sorted"

echo "pinned $pinned"
if [ -n "$since" ]; then echo "mode since $since"; else echo "mode full"; fi
echo "tracked $tracked listed $listed unchanged $unchanged empty $empty binary $binary record $record fenceless $fenceless"

n=0 bytes=0 files=0 current="" list=""
flush() {
  [ "$files" -gt 0 ] || return 0
  n=$((n + 1))
  printf '%s' "$list" > "$out/$n.txt"
  echo "slice $n $current $files $bytes $out/$n.txt"
  bytes=0 files=0 list=""
}
while IFS=$'\t' read -r row size file; do
  [ "$row" = "$current" ] || { flush; current="$row"; }
  [ $((bytes + size)) -le "$BUDGET" ] || flush
  bytes=$((bytes + size)) files=$((files + 1)) list="$list$file"$'\n'
done < "$out/plan.sorted"
flush
# Only the numbered lists stay beside the worktree.
rm -f "$out"/*.z "$out"/*.raw "$out"/tree.txt "$out"/text.txt "$out"/changed.txt \
  "$out"/plan.rows "$out"/plan.sorted
trap - EXIT
