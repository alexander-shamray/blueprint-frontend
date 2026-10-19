# Token usage — the measurements

[`token-plan.md`](token-plan.md) is the plan these figures serve; the report is
[`tools/token-usage/`](../tools/token-usage/README.md). **Every figure here is
a record of the day it was taken**, against the commit it names, and nothing in
this file is kept current: a later measurement is a new section under the
last, never an edit to an earlier one.

Columns are the report's own. `mean_context` is what one API call sent on
average (fresh input, cache writes and cache reads together), the context a
turn re-sends. `input_equivalent` prices the input side as uncached input
(writes at 1.25× or 2×, reads at 0.1×), so it is the one number that compares
two rows. `woken_equivalent` is the part of it spent after a wake, before the
next typed prompt.

## 2026-10-19 — the baseline, the owner's machine

**Taken against `main` at `77951c9`**, with 119 transcript directories read:
this checkout's, and every worktree and `claude -p` run beside it. The first
response counted is 2026-09-19.

### All history, 2026-09-19 to 2026-10-19

| | |
|---|---|
| Contexts | 1,243 |
| Calls | 18,204 |
| `mean_context` | 173,544 |
| `cache_write` | 78.5 M |
| `cache_read` | 3,080.6 M |
| `output` | 9.6 M |
| `input_equivalent` | 434.3 M |
| `woken_equivalent` | 226.2 M (52 % of `input_equivalent`) |

### The last week, 2026-10-12 to 2026-10-19

| | |
|---|---|
| Contexts | 687 |
| Calls | 8,896 |
| `mean_context` | 180,314 |
| `input_equivalent` | 212.2 M |
| `woken_equivalent` | 95.0 M (45 % of `input_equivalent`) |

### Who spent it, all history

The six rows that matter, by `input_equivalent`. **A command owns everything
until the next prompt a person types**, so `(no command)` is the work a
session did that no slash command started: most of it is a session continuing
after a compaction or a resume.

| Row | Contexts | Calls | `mean_context` | `input_equivalent` |
|---|---|---|---|---|
| `(no command)`, `main` | 567 | 4,567 | 215,751 | 126.0 M |
| `/ship`, `main` | 46 | 4,028 | 223,618 | 108.8 M |
| `skill:ship`, `main` | 21 | 1,571 | 289,304 | 51.9 M |
| `/ship`, `branch-reviewer` | 96 | 1,294 | 86,619 | 19.8 M |
| `quality-sets:sweep`, `bug-auditor` | 100 | 744 | 64,851 | 19.1 M |
| `skill:commit`, `main` | 7 | 469 | 266,393 | 13.6 M |

**`main` carries the cost.** Its rows are 73 % of `input_equivalent`, and a
`main` call re-sends 215 k to 289 k tokens where a reviewer's re-sends 59 k to
87 k. What a session keeps resident is therefore the lever, and the
subagents are not.

The `quality-sets:*` rows are runs of blueprint-backend's runner reading this
repository's transcripts directory; the runner is not ported here
(`token-plan.md`, *Owed*).

### What tool results put into main sessions, since 2026-10-12

A result stays in the context for every later turn, so characters here are
the best predictor of `mean_context`. Tokens are a quarter of the characters.

| Command | Tool | Results | Characters | About tokens |
|---|---|---|---|---|
| `quality-sets:sweep` | `Read` | 1,176 | 8.13 M | 2.03 M |
| `(no command)` | `Read` | 642 | 3.87 M | 0.97 M |
| `/ship` | `Bash` | 2,302 | 3.69 M | 0.92 M |
| `/ship` | `Read` | 261 | 1.38 M | 0.35 M |
| `(no command)` | `Bash` | 950 | 0.88 M | 0.22 M |
| `(no command)` | `Grep` | 498 | 0.80 M | 0.20 M |

**A `/ship` run's shell results are the largest thing it keeps** that it did
not choose to read: 2,302 results averaging 1.6 k characters. They are the
checks' output, `git` reads and the helpers' reports.

### One named `/ship` session

The session that ran the harness groups through `/ship` with the reviewer in
house (id `918fe0f0-921a-47f2-a859-b6a7574ddcfc`), measured on 2026-10-19
part-way through, at 653 calls. A session spans compactions and resumes, so
this is one named run's cost and not a per-pull-request one.

| Row | Contexts | Calls | `mean_context` | `input_equivalent` |
|---|---|---|---|---|
| `(no command)`, `main` | 10 | 437 | 368,243 | 17.6 M |
| `skill:ship`, `main` | 2 | 108 | 154,400 | 2.0 M |
| `(no command)`, `branch-reviewer` | 17 | 90 | 46,230 | 1.2 M |
| Total | 30 | 653 | 280,534 | 21.1 M |

**`mean_context` of 368 k on a session's own turns** is what a long session
re-sends after compactions and worktree switches. A reviewer round
costs a 46 k context, about an eighth of a `main` turn: the in-house review
is not where this session's tokens went.

### What is resident, by size

Bytes over four is close for prose and code.

| | Bytes | About tokens |
|---|---|---|
| `docs/harness-boundaries.md` | 164,060 | 41 k |
| `.claude/commands/ship.md` | 33,847 | 8.5 k |
| `.claude/commands/bug-sweep.md` | 18,983 | 4.7 k |
| `CLAUDE.md` | 17,316 | 4.3 k |
| `.claude/commands/security-sweep.md` | 13,438 | 3.4 k |
| `.claude/commands/pr.md` | 12,830 | 3.2 k |
| `.claude/commands/review-branch.md` | 10,791 | 2.7 k |

**`CLAUDE.md` is in every turn of every session**, and the commands above it
are in every turn from the moment they load. `harness-boundaries.md` is read
whole on the strength of one sentence in `CLAUDE.md`, which is the largest
single cost the table shows.

## What this baseline cannot say

- **The quality bar.** Steps that cut text must hold recall against issues
  earlier sweeps filed and findings earlier review rounds raised. The sets are
  owed (`token-plan.md`, *Owed*), so a step here is measured on tokens and
  argued on recall until they exist.
- **Whether a cut worked.** One machine and one owner's habits make a single
  week noisy; a step's evidence is its row against these, over a window of the
  same length.
