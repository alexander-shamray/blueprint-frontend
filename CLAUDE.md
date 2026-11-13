# CLAUDE.md

Guidance for Claude Code when working in this repository. This file is a
locator: what the repo is, who owns each fact, and the rules that must be true
before any other file is opened. Anything that moves when a PR lands — what
has been built, what a PR decided, a count of anything — is owned elsewhere and
cited from here by name, never restated.
**Read the file that covers what you are about to touch, before you touch it.**

| | |
|---|---|
| `.todo/blueprint-frontend.md` in the main checkout's parent directory (local) | The task list, for the user; `.harness/agent-rules.md` says when it changes, [`docs/change-locality.md`](docs/change-locality.md) §6 why it lives there |
| [`docs/change-locality.md`](docs/change-locality.md) | The operating contract: the trust order, the one rule, the change classes and their touch sets, and §6's working rules only this repository has |
| [`docs/client-architecture.md`](docs/client-architecture.md) | Why this client is shaped the way it is — one numbered argument each; §12 is where the spec turned out wrong |
| [`docs/superpowers/specs/2026-09-10-blueprint-frontend-design.md`](docs/superpowers/specs/2026-09-10-blueprint-frontend-design.md) | The design spec, §1–§11 — outranked by §12 above wherever the two disagree |
| [`docs/superpowers/plans/2026-09-10-blueprint-frontend.md`](docs/superpowers/plans/2026-09-10-blueprint-frontend.md) | The delivery record, Tasks 0–20 — complete; cited for a task's title and order, never as current truth |
| [`.harness/agent-rules.md`](.harness/agent-rules.md) | The working rules every repository on the harness shares, imported below; managed |
| [`docs/harness/working-rules.md`](docs/harness/working-rules.md) | Their detail for commits, pull requests, review, CI, tests and issues, and the review bar; managed |
| [`docs/harness/token-rules.md`](docs/harness/token-rules.md) | The reasons behind the subagent, review-round and plan rules; managed |
| [`docs/harness/pitfalls.md`](docs/harness/pitfalls.md) | Shell, git, machine and auto-mode traps; managed |
| [`docs/harness-boundaries.md`](docs/harness-boundaries.md) | What the harness grants these commands, and refuses; managed. **Read the section its index names for the change, not the file** |
| [`docs/harness-local.md`](docs/harness-local.md) | What the managed commands name by role, filled in for this repository: its documents, *Ship checks*, residuals and review examples |
| [`docs/commands/`](docs/commands/) | The argument behind each long command; the command file is the runbook. Managed, but for `review-branch.md`, this repository's own as its command is. Read the one for a command before disputing it |
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
.claude/               commands, agents, hooks, scripts — managed but for `.harness/config.json`'s `local` list
.harness/              the harness's config, manifest and shared rules
tools/                 token-usage/ — the report on where a session's tokens go;
                       lockfile-check/ — CI's hold of package-lock.json to the registry
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
`package-lock.json` moves in the same commit or the change is not done.
**`npm ci` finishes clean** — no advisory outside an `ALLOWED` row, at any
severity, and no `npm warn deprecated` — and a finding whose parent's range
excludes the fix is closed with an `overrides` entry;
`docs/client-architecture.md` §14 argues it and CI's `audit` job fails on
either. The
import boundaries in `eslint.config.js` are **a lint failure, not a review
comment**: a feature never imports another feature, and `core` knows nothing
about screens (spec §3); `src/app/core/boundaries.spec.ts` is the precise check.

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

## The harness

Every path `.harness/manifest.json` lists is managed: `blueprint-harness`
owns it, synced at the commit the manifest names, and a sync pull request
brings it here. `docs/harness-boundaries.md` is what the harness grants these
commands and refuses; read the section its index names before touching
anything under `.claude/`. A residual only this repository has goes in
`docs/harness-local.md` *Residuals*, and a working rule only this repository
has in `docs/change-locality.md` §6. The locality gate's script and suite and
the two document audits did not come with the harness:
`docs/change-locality.md` §3 says where the first gap bites, and
`docs/harness-local.md` *Residuals* where the audits' does. A bare `#NN`
inside a managed file names an issue in `blueprint-backend`, where most of
that machinery was built, or in `blueprint-harness`; it is not an issue here.

`/ship`, `/branch`, `/commit`, `/pr`, `/review-branch`, `/style-pass`,
`/security-sweep`, `/bug-sweep`, `/dispatch` and `/team` say what each does
in their own frontmatter; `/ship` runs `/branch`, `/commit` and `/pr` to a
merged PR and stops for nothing that is a judgement. The rules every
repository on the harness shares are these:

@.harness/agent-rules.md
