# CLAUDE.md

Guidance for Claude Code when working in this repository. This file is a
primer: what the repo is, where things are, and how to act here. Anything that
moves when a PR lands — what has been built, what a PR decided, a count of
anything — is owned elsewhere and cited from here by name, never restated.
**Read the file that covers what you are about to touch, before you touch it.**

| | |
|---|---|
| [`docs/change-locality.md`](docs/change-locality.md) | The operating contract: the trust order, the one rule, the change classes and their touch sets |
| [`docs/client-architecture.md`](docs/client-architecture.md) | Why this client is shaped the way it is — §1–§15, one argument each; §12 is where the spec turned out wrong |
| [`docs/superpowers/specs/2026-09-10-blueprint-frontend-design.md`](docs/superpowers/specs/2026-09-10-blueprint-frontend-design.md) | The design spec, §1–§11 — outranked by §12 above wherever the two disagree |
| [`docs/superpowers/plans/2026-09-10-blueprint-frontend.md`](docs/superpowers/plans/2026-09-10-blueprint-frontend.md) | The delivery record, Tasks 0–20 — complete; cited for a task's title and order, never as current truth |
| [`docs/harness-boundaries.md`](docs/harness-boundaries.md) | What the harness grants these commands, and refuses |
| [`docs/style-guide.md`](docs/style-guide.md) | The prose, TypeScript and Angular dialect, and which rules a linter enforces |
| [`docs/testing.md`](docs/testing.md) | What a checkout needs that `package.json` and `ci.yml` cannot say: the Playwright prerequisites, the worktree install, the setup file |

## What this repo is

`blueprint-frontend` is an Angular 22 + Ionic 9 client for the platform in
`alexander-shamray/dotnet-ddd-blueprint`, shipped to the web and, through
Capacitor 8, to Android and iOS. It is a **client of a backend it does not
own**: every port, every claim, every wire type here is downstream of a
decision somebody else made, and `docs/client-architecture.md` cites both ends
of each one. A value that "looks wrong" here is usually correct against a fact
you have not read yet.

The application is **standalone, zoneless and signal-based**: no NgModules, no
`BehaviorSubject` state, and `OnPush` on every component but the bootstrapped
root shell — `docs/style-guide.md` owns that exception and why it stands. Identity is
`angular-oauth2-oidc` against Keycloak, with two strategies — a web one and a
native one — behind one interface. There is no refresh token in the browser
(§2), permissions are claims rather than roles (§3), and the client never
computes money (§9).

### The tree

```
src/app/core/          api/ auth/ cart/ catalog/ commands/ config/ errors/ — shared, screen-agnostic
src/app/features/      account cart checkout order-placed products publish — one slice each
src/app/shared/        components every feature may import
src/app/tabs/          the shell; app.routes.ts and app.config.ts are the composition roots
src/theme/, src/styles.css   Ionic's variables and the global sheet
e2e/                   the Playwright smoke, against a real stack
android/, ios/         committed, not generated here; CI compiles the manifest a developer edits
capacitor.config.ts    the one file that decides what `cap sync` writes into both
.github/workflows/     ci — the jobs `docs/client-architecture.md` §14 names, including `harness`
.claude/               commands, agents, hooks, scripts, the reviewer sandbox
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
Read it before editing. It names the change classes, the touch set each may
edit, the repo-wide mutexes, and what to do with a stale restatement met in
passing: leave it.

The spec and the application are one artefact with two representations. A code
change that contradicts a spec section is not done until the section is
amended in the same PR, or the code is changed to match — pick one, in the PR.
Where the spec is genuinely wrong, the answer is a
`docs/client-architecture.md` §12 entry saying what was claimed, what is true,
and where the truth shows; sections there are superseded with the old claim
kept, never rewritten. This file and the files it points at are inside the
rule too, and **no gate reads any of them**: a rule stated here and argued
there moves in both, or it drifts silently.

## The commands

```bash
npm ci                      # from the lockfile, always — never `npm install`
npm run lint                # ESLint over src/**/*.ts and src/**/*.html
npm test                    # Vitest; `CI=true npm test` confirms it exits rather than watching
npm run build               # the production bundle
npm start                   # the dev server, on 5173
npm run e2e                 # Playwright — needs the backend's stack; see docs/testing.md
npm run emulator:android    # build for the emulator and sync; relaxes cleartext ON PURPOSE
```

Inside a command or a chain, use `bash .claude/scripts/npm-checks.sh
[all|fast|lint|test|build]` instead, which holds no free parameter.
**It has no `e2e` mode**, because Playwright needs the backend's Compose stack
and a downloaded browser — `docs/testing.md` owns which, and on which ports —
and a suite that passed because nothing was listening would be worse than
none. Three things hold first: **`npm ci`, never
`npm install`**, because `install` may rewrite the lockfile; **a fresh
worktree has no `node_modules`** and the first check in it fails on a missing
`ng` binary; and **lint, the unit suite and the web build cover none of the
native surface** — the emulator relaxations live in files `cap sync`
generates, and CI's `android` job is the only thing that asserts them, in both
directions.

## Build policy

Versions live in `package.json` with **exact** pins — no `^`, no `~` — and
`package-lock.json` moves in the same commit or the change is not done.
`.nvmrc` pins Node and CI reads it with `node-version-file`. The import
boundaries in `eslint.config.js` are **a lint failure, not a review comment**:
a feature never imports another feature, and `core` knows nothing about
screens (spec §3). `src/app/core/boundaries.spec.ts` is the precise check, and
its comment says exactly where the lint rule over- and under-fires — read it
before concluding the rule is wrong.

One lesson stays here, because its subject is every other rule: **a gate that
silently stops covering the newest surface is the most-repeated failure in
these repositories**, and the only defence is a test whose subject is *what
the gate is looking at*, not what it found. `src/vitest-setup.ts` is the local
form of that argument: a load-bearing import with no binding, which a linter
would offer to remove.

## Style

The dialect is [`docs/style-guide.md`](docs/style-guide.md), the master copy;
**read it before "correcting" anything**, because its *Settled choices* table
names the house forms a reviewer reads as oversights. `/style-pass` moves a
corrected form through the corpus, the guide and the linters in one change.
These stay here because they have to be true before anyone opens the guide:

- **Prose wraps at 80 columns** (tables, links and code may exceed it), **code
  at 100** — Prettier's `printWidth` — in **British spelling** with literal
  dashes, and **identifiers keep their real spelling**: `ChangeDetectionStrategy`,
  never "corrected" or Americanised.
- **`inject()` at field level**, never a constructor parameter. **Standalone
  components** with an explicit `imports` array and `OnPush`. **Signals** for
  state, exposed through `asReadonly()`; RxJS for HTTP and genuine streams.
- **Single quotes, semicolons, trailing commas, two-space indent** — all
  Prettier's, so do not argue them in a review. **No `any`**, and no `!` on a
  value the server supplied.
- **Path aliases `@core/`, `@shared/`, `@features/`** across areas, relative
  imports within one. A deep relative import is the spelling the boundary
  rules cannot see.
- **LF line endings.** `.gitattributes` is `* text=auto eol=lf`, and a CRLF
  that reaches the tree breaks the `.claude/scripts` shebangs mid-line.

## Working in this repo

- **Read before you edit**: the claim you are about to change is usually
  stated more than once. `app.config.ts` and `app.routes.ts` are the
  composition roots, and a Class A change that has to edit one has outgrown
  its class.
- **Commit messages** are semantic and present-tense — `docs:`,
  `feat(<scope>):`, `fix:`, `chore:`, `refactor:`, `test:` — and the body
  argues the change. A `Closes #n` in a commit body fires on merge whatever
  the description says, so the description is reconciled to the commits and
  never the reverse.
- **The issue vocabulary is wider than the label helper**: kind is `security`,
  `bug` or `documentation`, and the helper does not create the last. A
  `## Severity` in the body and the label both have to say it.
- **A reply is not a resolution.** Resolve a review thread in the same act as
  the reply, and leave an `Ask` open on purpose.
- **Uncommitted work in the tree belongs in the PR being worked on**, in its
  own commit with a body that argues it. **Never revert it to clean the tree**;
  if it does not belong here, say so and ask rather than decide by deleting.
- **A `#NN` inside `.claude/` or `docs/harness-boundaries.md` is an issue in
  the backend repository**, where that machinery was built. It is not an issue
  here.

## Available commands

| | |
|---|---|
| `/ship` | Clean `main` → `/branch` → checks → `/commit` → `/pr` → both review loops → merge → teardown. **It stops for nothing that is a judgement** |
| `/branch` | A correctly named branch **in a sibling worktree** the session moves into; in place when the tree is dirty or the parent is not writable |
| `/commit` | Split the working tree into semantic commits with arguing bodies |
| `/pr` | Open a PR in the house body form |
| `/review-grok` | Triage an external review into a resolution record |
| `/review-copilot` | Triage Copilot's PR comments — verify each before acting |
| `/review-branch` | Review the branch against `main` for contradictions; writes `suggestions.md` |
| `/style-pass` | Apply one corrected code form corpus-wide, then record it in the guide and the linters |
| `/security-sweep` | Loop a defensive security audit in a throwaway worktree, filing an issue per confirmed medium-or-above finding |
| `/bug-sweep` | The same loop aimed at defects, filed at **critical or high**, confirmed by reading because the grant runs no build |

### What cuts across them

[`docs/harness-boundaries.md`](docs/harness-boundaries.md) is the inventory of
what the harness grants these commands and what it refuses them — every grant
wider than the operation it buys, and the hooks that closed the rest. **Read
it before touching anything under `.claude/`**, and state a new residual there
rather than here. Three rules reach every session, so they stay:

- **File permission rules take `Edit(...)`, never `Write(...)`** — a
  `Write(path)` rule matches nothing and stops Claude Code from starting.
- **`.claude/settings.json` self-locks, not instantaneously** — a change to it
  lands complete and goes last, and a restore is verified by reading the file,
  never by trying what it forbids.
- **The two hooks use `run-guard.sh`**, which locates a compatible Python
  launcher before invoking the guard.
- **`python -m unittest discover -s .claude/scripts -p 'test_*.py'` is the
  harness's own suite** — it covers the deny lists, the frontmatter grants,
  the helper shapes and the hooks. It reads `git ls-files`, so a new tracked
  root file or top-level tree fails it until somebody decides which side of
  the boundary it is on. Run it after any change under `.claude/`. Any Python
  3.12 will do — `py -3.12` on Windows, `python` elsewhere — and CI's
  `harness` job runs `python` on all three platforms, Windows included, so
  that is the spelling to use when reproducing it. `docs/testing.md` owns the
  prerequisite; the hooks' `py` wiring above is a different question.

### What was not ported, and is therefore missing

Stated here rather than discovered: this repository's `.claude/` came from the
backend, and three things that back it up there do not exist here.
`.github/closure-gate/` checked a PR body's closing keywords against what the
merge would actually do; `.github/locality-gate/` failed a PR on a path
outside its declared touch set; and `/validate-blueprint` and `/check-links`
audited a document tree this repository does not have. What stands instead is
`pr-locality.sh` and `pr-closure-input.sh` — helpers somebody runs, not gates
that run themselves. `/pr` and `docs/change-locality.md` §3 each say so where
the gap bites.
