#!/usr/bin/env bash
# Judge a pull request's changed paths against the `| Class |` and
# `| Touch set |` rows its body declares, and print a verdict per path — and
# nothing the author wrote. Read-only, fixed field set.
#
# **Exists so that /review-branch, /review-copilot and /ship can read the two
# rows `docs/change-locality.md` asks a PR body to carry without holding
# `Bash(gh pr view:*)`** — the grant that reaches `--json reviews`, the
# unfiltered feed #56 closed. `body` is the one field this reads from the
# pull request, `filename` the one field it reads from the files endpoint;
# what applies is the shape rule every helper in this directory follows — a
# caller that chooses fields can choose `reviews`, so this one chooses none.
#
# **The output never contains the touch-set cell.** A pull request author is
# not a trusted party, /review-copilot takes any PR number, and a row was the
# one place an author's text reached an Edit-capable agent unfiltered. A path
# grammar cannot close that — `Ignore_all_previous_instructions.md` is a path
# — so the cell is consumed here and only a verdict leaves: one `class` line
# whose value is letters this script validated, then one `inside <path>` or
# `outside <path>` line per changed file, where the path is the diff's own
# and the word is this script's. A caller acts on `outside` lines and never
# sees what the set said. **A changed path is the author's text too** — the
# author names the files, and git permits a newline inside a name — so each
# arrives JSON-encoded, one per line and unambiguous, and is printed only if
# it decodes to a plain path: no escape in it, path characters only, a `/`
# or a `.` in it, no `..` segment. Any other name refuses the whole run,
# because a verdict list with one line withheld is a list a caller would
# read as complete.
#
# Nothing is printed when the body carries neither row; a caller that reads
# nothing skips its touch-set check and says so, and does not infer a class.
# One row without the other is refused, because each command reads the pair.
# A row that fails its grammar is refused with exit 3 naming the row and not
# its content: a class cell is one letter A–E or two distinct letters joined
# by `+`; a touch-set cell is a comma-separated list of path tokens, bare or
# in balanced backticks, of path and glob characters — `*`, `**`, `?` and a
# brace alternation — each carrying a `/` or a `.`, and each
# repository-relative: no leading `/`, no `./`, no `..` segment, brace
# alternatives included, since the edit-target guard judges where an edit
# inside the checkout lands and not a path naming the outside.
#
# **The verdict narrows and grants nothing.** What holds authority is the
# caller's own deny list and the class's tree set in the contract; an
# `outside` line is a finding for the caller, and an `inside` line is not a
# licence for anything the caller's grant refuses.
set -euo pipefail
pr="${1:?usage: pr-locality.sh <pr-number>}"
[[ "$pr" =~ ^[0-9]+$ ]] || { echo "pr must be a number" >&2; exit 2; }
refuse() { echo "$1" >&2; exit 3; }
# The body is captured before it is filtered, so a `gh` failure — no
# authentication, no network, no such pull request — is fatal under `set -e`
# rather than indistinguishable from a body with no rows. Only grep's own
# no-match status, which is exactly 1, is masked.
body=$(gh pr view "$pr" --json body --jq .body)
class_row=$(grep -E '^\| *Class *\|' <<<"$body" || [ $? -eq 1 ])
touch_row=$(grep -E '^\| *Touch set *\|' <<<"$body" || [ $? -eq 1 ])
# Exactly one of each, or none. A second row is where a valid first row
# would have carried an invalid second past a check that only asked whether
# any row matched, so two rows is refused before either grammar is consulted.
[ "$(grep -c . <<<"$class_row")" -le 1 ] || refuse "more than one Class row"
[ "$(grep -c . <<<"$touch_row")" -le 1 ] || refuse "more than one Touch set row"
if [ -z "$class_row" ] && [ -z "$touch_row" ]; then exit 0; fi
[ -n "$class_row" ] && [ -n "$touch_row" ] || refuse "one row without the other"
# The class cell: the text between the second `|` and the closing one.
class=$(sed -E 's/^\| *Class *\| *//; s/ *\| *$//' <<<"$class_row")
grep -Eq '^[A-E](\+[A-E])?$' <<<"$class" || refuse "the Class row is not a class"
[ "${class:0:1}" != "${class:2:1}" ] || refuse "the Class row repeats a class"
# The touch-set cell, then each comma-separated token on its own.
cells=$(sed -E 's/^\| *Touch set *\| *//; s/ *\| *$//' <<<"$touch_row")
case "$cells" in *'|'*) refuse "the Touch set row is not one cell" ;; esac
[ -n "$cells" ] || refuse "the Touch set row is empty"
# Split on commas outside braces, because a brace glob carries its own —
# `.claude/commands/{pr,ship}.md` is one token, not two halves of one.
items=(); cur=""; depth=0
for ((i = 0; i < ${#cells}; i++)); do
  ch="${cells:i:1}"
  case "$ch" in
    '{') depth=$((depth + 1)) ;;
    '}') depth=$((depth - 1)); [ "$depth" -ge 0 ] || refuse "the Touch set row has an unbalanced brace" ;;
    ',') if [ "$depth" -eq 0 ]; then items+=("$cur"); cur=""; continue; fi ;;
  esac
  cur+="$ch"
done
items+=("$cur")
[ "$depth" -eq 0 ] || refuse "the Touch set row has an unbalanced brace"
patterns=()
for item in "${items[@]}"; do
  t="${item#"${item%%[! ]*}"}"
  t="${t%"${t##*[! ]}"}"
  case "$t" in
    '`'*'`') t="${t:1:${#t}-2}" ;;
    *'`'*) refuse "the Touch set row has an unbalanced backtick" ;;
  esac
  # **The two grammars here disagreed, and the touch-set one was the narrower
  # (#19).** A changed path is admitted with `@` and `+` in it — git permits
  # both — while a declared set naming `src/app/@types/**` or `docs/a+b.md`
  # made this `refuse` and exit 3 before printing any verdict. `/review-branch`,
  # `/review-copilot` and `/ship` all read a helper that prints nothing as
  # "names no class and no bound", so a legitimate touch set silently degraded
  # the locality check rather than failing it visibly. This is the changed-path
  # grammar plus the glob characters `*?{},`, which makes it a superset rather
  # than a second list to keep in step.
  grep -Eq '^[A-Za-z0-9_./*?{},()@+-]+$' <<<"$t" ||
    refuse "the Touch set row is not a path list"
  case "$t" in *[/.]*) ;; *) refuse "the Touch set row is not a path list" ;; esac
  t="${t%/}"
  # A brace alternative is a segment start too: `{../outside,docs/x.md}`
  # expands to a path that leaves the checkout, so the boundary is judged
  # over the token with its braces dropped and its alternatives joined as
  # segments, where a leading `/`, a `./` and a `..` all show as segments.
  n="${t//[\{\}]/}"
  n="${n//,//}"   # every `,` becomes `/`: the replacement is the last `/`
  case "/$n/" in
    *//*|*/./*|*/../*) refuse "the Touch set row names a path outside the repository" ;;
  esac
  # **An empty brace alternative is refused, not translated (#70).** `{a,}`
  # becomes `(a|)` and `{}` becomes `()`, and an empty alternative in an ERE
  # is undefined by POSIX: GNU grep reads `docs/{a,}.md` as admitting
  # `docs/.md` and `docs/a.md`, BSD grep (macOS) matches neither, so the same
  # touch set judged one path `inside` on one machine and `outside` on
  # another, with no error. A refusal is the same on every platform, and no
  # token in use writes one. A leading empty alternative, `{,a}`, already
  # fails the boundary check above; `{}`, `{a,}`, `,,` and `,}` end here. A
  # `,` outside braces never reaches this point — the split consumed it.
  case "$t" in
    *'{}'*|*'{,'*|*',,'*|*',}'*)
      refuse "the Touch set row has an empty brace alternative" ;;
  esac
  # The token as an anchored regular expression: `**` crosses directories,
  # `*` and `?` do not, braces are alternation, and a token also covers
  # everything beneath the directory it names — `tests/Ordering.*` is the
  # test projects, not files whose name happens to start that way. A
  # trailing `/` names the directory the same way `docs` would, and was
  # dropped above before the boundary was judged.
  #
  # **`\x01` was a GNU `sed` escape and macOS ships BSD `sed` (#23).** There it
  # is not an escape at all, so the sentinel was written and read as the two
  # literal characters `x` and `1` — which leaves `**` mistranslated, or a
  # token containing that pair read as the placeholder. Either way the helper
  # emits a wrong `inside`/`outside` verdict rather than refusing, and all
  # three callers act on verdicts: a wrong one is worse here than a refusal.
  #
  # The placeholder is built from a character the touch-set grammar above
  # rejects, which is what makes a collision unforgeable rather than unlikely
  # — `%` cannot appear in a token, so no token can spell this.
  #
  # **`+` joins the escape set with the grammar that admits it.** It is an ERE
  # quantifier, so an unescaped `docs/a+b.md` would match `docs/aab.md` — a
  # false `outside` traded for a silently wrong `inside`, which is the same
  # trade the changed-path side already refuses. `@` needs no escape.
  re=$(printf '%s' "$t" |
    sed -e 's/[.()+]/\\&/g' -e 's/\*\*/%%GLOBSTAR%%/g' -e 's/\*/[^\/]*/g' \
        -e 's/?/[^\/]/g' -e 's/%%GLOBSTAR%%/.*/g' \
        -e 's/{/(/g' -e 's/}/)/g' -e 's/,/|/g')
  patterns+=("^${re}(/.*)?$")
done
# The changed paths are the diff's own, and each gets the one word this
# script chooses for it. `filename` is the whole of what is read, and it is
# read as a JSON string so that a newline inside a name cannot be a second
# line: a name that needed an escape is refused rather than decoded.
files=$(gh api "repos/{owner}/{repo}/pulls/$pr/files" --paginate --jq '.[].filename | @json')
#
# **No process is spawned per changed path (#61).** The validation below and
# the matcher after it each ran a `grep` per path — the matcher once per path
# per pattern — so the cost was quadratic in the two things a pull request
# grows, and on Windows, where process creation is the expensive operation, a
# 50-file change against a 10-token set was the difference between a helper
# that answers and one that appears to hang inside /ship.
#
# The character check is a `case` over the grammar's characters spelled out
# one by one rather than as ranges, because a range in a bracket expression is
# the locale's to interpret and this list is not: it admits exactly the ASCII
# characters `^[A-Za-z0-9_./@+()-]+$` names, and any other byte or character
# — raw UTF-8 included — refuses the run as before. An empty name refuses too,
# as `+` did; the `[/.]` check below would also catch it, with the same
# message.
verdicts=()
list=""
while IFS= read -r line; do
  [ -n "$line" ] || continue
  case "$line" in
    '"'*'"') ;;
    *) refuse "a changed path did not arrive as a JSON string" ;;
  esac
  case "$line" in *\\*) refuse "a changed path is not a plain path" ;; esac
  path="${line:1:${#line}-2}"
  case "$path" in
    ''|*[!ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_./@+\(\)-]*)
      refuse "a changed path is not a plain path" ;;
  esac
  case "$path" in *[/.]*) ;; *) refuse "a changed path is not a plain path" ;; esac
  case "/$path/" in *//*|*/./*|*/../*) refuse "a changed path is not a plain path" ;; esac
  verdicts+=("$path")
  list+="$path"$'\n'
done <<<"$files"
printf 'class %s\n' "$class"
# **One `grep` per pattern over every path at once, and the matcher is still
# `grep -E`.** A bash `[[ =~ ]]` would spawn nothing, and it was not taken:
# it hands the pattern to the platform's own regcomp — glibc, Cygwin's and
# Apple's are three engines — where `grep -E` is the one these patterns and
# their verdicts were written and tested against. The verdict decides `inside`
# from `outside` for a path the author chose, so the engine stays and only the
# batching moves. `grep` is line-oriented and a validated path holds no
# newline, so line N's match is exactly what `grep -Eq` said of path N alone;
# `-n` says which lines matched. A pattern `grep` cannot compile matches
# nothing, as it did per path, and leaves every other pattern's verdict alone
# — the reason this is one `grep` per pattern and not one `-e` list.
hits=()
if [ -n "$list" ]; then
  for re in "${patterns[@]}"; do
    matched=$(grep -nE -e "$re" <<<"${list%$'\n'}" || true)
    while IFS=: read -r n _; do
      [ -z "$n" ] || hits[n - 1]=1
    done <<<"$matched"
  done
fi
i=0
for path in "${verdicts[@]}"; do
  verdict=outside
  [ -z "${hits[i]:-}" ] || verdict=inside
  printf '%s %s\n' "$verdict" "$path"
  i=$((i + 1))
done
