# Token usage — the plan

**Goal.** A Claude Code session here spends its tokens on the change, not on
re-reading text the change does not need. Every turn re-sends the whole
context, so a prompt that stays resident costs far more than its size. This
file says where the tokens go, sequences the work that cuts them, and names
what each step must keep true so that a saving is not bought with missed
findings.

It follows blueprint-backend's `docs/token-plan.md`, which cut a session's
resident context in six steps, each measured before and after. **The
measurement came first there and comes first here**: this is step 1.

The rules this plan moves are not restated. [`change-locality.md`](change-locality.md)
owns the rule for documents, [`harness-boundaries.md`](harness-boundaries.md)
owns what the harness grants, and each command owns its own procedure. The
figures are [`token-usage.md`](token-usage.md)'s, taken against `main` at
`77951c9` on 2026-10-19, and nothing here is kept current.

## 1. What the baseline says

**A session's own turns are 73 % of what it spends**, and each re-sends
215 k to 289 k tokens (`token-usage.md`, *Who spent it*). The subagents re-send
a third of that. So the lever is what a `main` session keeps resident, in this
order of size:

| | About tokens | Resident |
|---|---|---|
| `docs/harness-boundaries.md` | 41 k | Read whole before anything under `.claude/`; `CLAUDE.md` says to |
| `.claude/commands/ship.md` | 8.5 k | Every turn of a `/ship` run |
| `.claude/commands/bug-sweep.md` | 4.7 k | Every turn of a sweep |
| `CLAUDE.md` | 4.3 k | Every turn of every session, and of every subagent that inherits it |
| `.claude/commands/security-sweep.md` | 3.4 k | Every turn of a sweep |
| `.claude/commands/pr.md`, `branch.md`, `review-branch.md` | 3.2 k, 2.3 k, 2.7 k | Loaded by `/ship` and kept |

A `/ship` run therefore carries about 20 k tokens of this repository's text on
every turn before it reads any code, and a session that follows `CLAUDE.md`
into `harness-boundaries.md` adds 41 k. **Tool results are the second cost**:
a `/ship` run's shell results alone are 0.9 M tokens in a week, because a
result stays in the context for every later turn.

**The in-house review is not the problem.** A `branch-reviewer` round re-sends
about an eighth of a `main` turn (`token-usage.md`, *One named `/ship`
session*). What the review needs is its bar, not a smaller reviewer.

## 2. The targets

Each is a ratio against the baseline, over a window of the same length, with
the same owner at the keyboard. A step that misses its target says so in its
own section of `token-usage.md` and the target stays.

| | Baseline | Target |
|---|---|---|
| What `CLAUDE.md` puts in every turn | 4.3 k | under 2 k |
| What a session reads to touch `.claude/` | 41 k | the section it needs, 2 k to 4 k |
| A `/ship` run's resident commands | about 20 k | under 12 k |
| `mean_context` of `/ship` on `main` | 223,618 | a fifth lower |

## 3. The sequence

One pull request per step, each ending with its row in `token-usage.md`. They
are filed as issues of their own; a step starts when the one it depends on
has merged.

| Step | Issue | What it does | State on 2026-10-20 |
|---|---|---|---|
| 1 | #168 | The report, the baseline and this plan | done |
| 2 | #169 | The review loop, the delegation brief and the planning rule leave user memory and become `CLAUDE.md`'s, so a subagent is briefed the same way each time | this pull request |
| 3 | #170 | `CLAUDE.md` cut to a locator and its hard rules; `harness-boundaries.md` split into indexed sections, so a session reads the one it needs | done |
| 4 | #171 | `/ship` stops carrying two external review loops it skips: the in-house `branch-reviewer` is the review, and the Grok and Copilot commands are archived (`archive/external-reviewers`) | done |
| 5 | #172 | A sweep slices the tree, follows leads after round 1, and sweeps only what changed | open, after step 4 |
| 6 | #173 | Each long command is split into a runbook, resident while it runs, and an argument under `docs/commands/`, which each rule cites | done |

**Step 3 is the largest single win here**: `harness-boundaries.md` is more
than six times the size of the backend's before its own step 3, and nothing
indexes it.

## 4. What each step must keep true

A cut that loses a finding is a regression, so a step that removes text from a
command or an agent holds two things.

- **Every rule it drops is cited from its new owner.** The one-owner rule
  applies: a fact moves, and the old place names the new one.
- **Recall holds against the quality sets**, below. Until they exist a step
  argues recall by reading, in its pull request, which rule each removed
  paragraph served and where it went.

## 5. Owed

- **The quality sets.** Two lists, built from this repository's history: the
  issues earlier sweeps filed, and the findings earlier review rounds raised.
  A run of a cut command over a pinned tree must find them again. The backend
  keeps `tools/quality-sets` for this; it is not ported, because it needs
  the lists first, and the report already reads a quality-set run's
  transcripts by the name that runner gives its worktree so that it works the
  day the runner does.
- **A CI job for the report's suite.** The suite is run by hand
  (`python -m unittest discover -s tools/token-usage -p 'test_*.py'`). The
  backend gates nothing on it and runs it as a job; a job here is an edit to
  `.github/workflows/ci.yml`, which `/ship` is denied, so it is the owner's.

## After every step

Run the report over the same window as the baseline, add a dated section to
[`token-usage.md`](token-usage.md) with the commit it was taken against, and
say which target moved. A step is done when its pull request has merged and
that section exists.
