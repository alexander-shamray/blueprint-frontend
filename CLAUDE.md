# CLAUDE.md

Guidance for Claude Code when working in this repository. This file is a
locator: what the repo is, who owns each fact, and the rules that must be true
before any other file is opened. Anything that moves when a PR lands — what
has been built, what a PR decided, a count of anything — is owned elsewhere and
cited from here by name, never restated.
**Read the file that covers what you are about to touch, before you touch it.**

| | |
|---|---|
| `TODO.md` (gitignored, local) | The task list, for the user; [`docs/change-locality.md`](docs/change-locality.md) §6 says how it is kept |
| [`docs/change-locality.md`](docs/change-locality.md) | The operating contract: the trust order, the one rule, the change classes and their touch sets, and §6's working rules (commits, issues, review threads, `TODO.md`) |
| [`docs/client-architecture.md`](docs/client-architecture.md) | Why this client is shaped the way it is — §1–§15, one argument each; §12 is where the spec turned out wrong |
| [`docs/superpowers/specs/2026-09-10-blueprint-frontend-design.md`](docs/superpowers/specs/2026-09-10-blueprint-frontend-design.md) | The design spec, §1–§11 — outranked by §12 above wherever the two disagree |
| [`docs/superpowers/plans/2026-09-10-blueprint-frontend.md`](docs/superpowers/plans/2026-09-10-blueprint-frontend.md) | The delivery record, Tasks 0–20 — complete; cited for a task's title and order, never as current truth |
| [`docs/harness-boundaries.md`](docs/harness-boundaries.md) | What the harness grants these commands, and refuses. **Read the section its index names for the change, not the file** |
| [`docs/commands/`](docs/commands/) | The argument behind each long command (`/ship`, `/branch`, `/bug-sweep`, `/security-sweep`, `/review-branch`); the command file is the runbook. Read the one for a command before editing or disputing it |
| [`docs/style-guide.md`](docs/style-guide.md) | The prose, TypeScript and Angular dialect, and which rules a linter enforces |
| [`docs/testing.md`](docs/testing.md) | What a checkout needs that `package.json` and `ci.yml` cannot say: the Playwright prerequisites, the worktree install, the harness suite, the code-index CLI's pin |
| [`docs/token-plan.md`](docs/token-plan.md) | Where a session's tokens go and the steps that cut them; [`docs/token-usage.md`](docs/token-usage.md) holds the measurements and `tools/token-usage/` the report |
| [`.claude/skills/codebase-index/`](.claude/skills/codebase-index/) | Query the local index before reading whole files |
| [`.mcp.json`](.mcp.json) | The index as an MCP server on the startup checkout, started only through `node .claude/skills/codebase-index/scripts/mcp-launch.mjs` and never through `bash`. Install the CLI at the version `docs/testing.md` pins (#147); it is not a repo package |

## What this repo is

`blueprint-frontend` is an Angular 22 + Ionic 9 client for the platform in
`alexander-shamray/blueprint-backend`, shipped to the web and, through
Capacitor 8, to Android and iOS. It is a **client of a backend it does not
own**: every port, every claim, every wire type here is downstream of a
decision somebody else made, and `docs/client-architecture.md` cites both ends
of each one. A value that "looks wrong" here is usually correct against a fact
you have not read yet.

The application is **standalone, zoneless and signal-based**; identity, the
claims model and the rule that the client never computes money are
`docs/client-architecture.md` §2, §3 and §9.

```
src/app/core/          api/ auth/ cart/ catalog/ commands/ config/ errors/ orders/ — shared, screen-agnostic
src/app/features/      account cart checkout order-placed orders products publish — one slice each
src/app/shared/        components every feature may import
src/app/tabs/          the shell; app.routes.ts and app.config.ts are the composition roots
src/theme/, src/styles.css   Ionic's variables and the global sheet
e2e/                   the Playwright smoke, against a real stack
android/, ios/         committed, not generated here; CI compiles the manifest a developer edits
capacitor.config.ts    the one file that decides what `cap sync` writes into both
.github/workflows/     ci — the jobs `docs/client-architecture.md` §14 names, including `harness`
.claude/               commands, agents, hooks, scripts
tools/                 token-usage/ — the report on where a session's tokens go
docs/                  this file's table, above
```

**Precedence where two documents disagree**: `docs/client-architecture.md`
beats the spec — §12 exists because execution found several of the spec's
claims untrue — and the code beats both on a matter of fact.
`docs/superpowers/plans/` is a delivery record, never edited to match what the
code became. `.remember/` is session state; never edit it.

## The one rule that matters

**Every fact has exactly one owner, and every other mention cites the owner.**
[`docs/change-locality.md`](docs/change-locality.md) is how that is kept true.
Read it before editing: the change classes, the touch set each may edit, the
repo-wide mutexes, and what to do with a stale restatement met in passing —
leave it.

The spec and the application are one artefact with two representations. A code
change that contradicts a spec section is not done until the section is
amended in the same PR, or the code is changed to match. Where the spec is
genuinely wrong, the answer is a `docs/client-architecture.md` §12 entry saying
what was claimed, what is true, and where the truth shows; sections there are
superseded with the old claim kept, never rewritten. This file and the files it
points at are inside the rule too, and **no gate reads any of them**: a rule
stated here and argued there moves in both, or it drifts silently.

## The commands

```bash
npm ci                      # from the lockfile, always — never `npm install`
npm run lint                # ESLint over src/ and e2e/, then tsc over e2e/
npm test                    # Vitest; `CI=true npm test` confirms it exits rather than watching
npm run build               # the production bundle
npm start                   # the dev server, on 5173
npm run e2e                 # Playwright — needs the backend's stack; see docs/testing.md
npm run emulator:android    # build for the emulator and sync; relaxes cleartext ON PURPOSE
```

Inside a command or a chain, use `bash .claude/scripts/npm-checks.sh
[all|fast|lint|test|build]`, which holds no free parameter. **It has no `e2e`
mode**: Playwright needs the backend's Compose stack and a browser
(`docs/testing.md`). A fresh worktree has no `node_modules`, and `npm-checks.sh`
refuses one until `npm ci` has run there. **Lint, the unit suite and the web
build cover none of the native surface**; CI's `android` job is the only thing
that asserts it, in both directions.

## Build policy

Versions live in `package.json` with **exact** pins — no `^`, no `~` — and
`package-lock.json` moves in the same commit or the change is not done. The
import boundaries in `eslint.config.js` are **a lint failure, not a review
comment**: a feature never imports another feature, and `core` knows nothing
about screens (spec §3); `src/app/core/boundaries.spec.ts` is the precise check.
One lesson stays here, because its subject is every other rule: **a gate that
silently stops covering the newest surface is the most-repeated failure in
these repositories**, and the only defence is a test whose subject is *what the
gate is looking at*, not what it found.

## Style

The dialect is [`docs/style-guide.md`](docs/style-guide.md); **read it before
"correcting" anything**, because its *Settled choices* table names the house
forms a reviewer reads as oversights. These stay here because they have to be
true before anyone opens it:

- **Prose wraps at 80 columns** (tables, links and code may exceed it), **code
  at 100**, in **British spelling** with literal dashes; **identifiers keep
  their real spelling**: `ChangeDetectionStrategy`, never "corrected".
- **`inject()` at field level**, **standalone `OnPush` components**, **signals**
  for state; **no `any`**, and no `!` on a value the server supplied. Quotes,
  semicolons and indent are Prettier's.
- **Path aliases `@core/`, `@shared/`, `@features/`** across areas, relative
  imports within one.
- **LF line endings.** `.gitattributes` is `* text=auto eol=lf`, and a CRLF
  that reaches the tree breaks the `.claude/scripts` shebangs mid-line.

## Working in this repo

The working rules — commit messages and `Closes #n`, the issue vocabulary,
resolving a review thread, uncommitted work, and how `TODO.md` is kept — are
`docs/change-locality.md` §6's. Two reach every session, so they stay:

- **Move an issue's row in `TODO.md` from Remaining to In progress before
  entering a worktree directory**, because from inside one the file may be
  refused. Only the main checkout's copy counts.
- **A `#NN` inside `.claude/` or `docs/harness-boundaries.md` is an issue in
  the backend repository**, where that machinery was built. It is not an issue
  here.

`/ship`, `/branch`, `/commit`, `/pr`, `/review-branch`, `/style-pass`,
`/security-sweep` and `/bug-sweep` say what each does in their own
frontmatter; `/ship` runs the others to a merged PR and stops for nothing that
is a judgement.

### Under `.claude/`

**Read the section of `docs/harness-boundaries.md` its index names for the
change before touching anything here**, and state a new residual there, not
here. Four rules reach every session:

- **File permission rules take `Edit(...)`, never `Write(...)`** — a
  `Write(path)` rule matches nothing and stops Claude Code from starting.
- **`.claude/settings.json` self-locks, not instantaneously** — a change to it
  lands complete and goes last, and a restore is verified by reading the file,
  never by trying what it forbids.
- **Every hook uses `run-guard.sh`**; the index refresh and the three hints are
  not guards, and their commands end `|| :` because the launcher's exit 2 would
  erase the prompt or block every call (*The index hints and the root guard*).
- **`python -m unittest discover -s .claude/scripts -p 'test_*.py'` is the
  harness's own suite** and CI's `harness` job runs it on three platforms. Run
  it after any change under `.claude/`; it reads `git ls-files`, so a new
  tracked root file or top-level tree fails it until somebody decides which side
  of the boundary it is on. `docs/testing.md` owns the prerequisite and the
  faster per-class runner.

This repository's `.claude/` came from the backend, and the closure gate, the
locality gate and the two document audits did not come with it:
`docs/change-locality.md` §3 and `/pr` say where the gap bites.
