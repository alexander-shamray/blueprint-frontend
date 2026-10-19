---
description: Review branch vs main for contradictions; recheck suggestions.md when it already exists
argument-hint: "[recheck | full | --local]"
allowed-tools: Read, Grep, Glob, Write, Edit, Bash(git diff:*), Bash(git log:*), Bash(git status:*), Bash(git merge-base:*), Bash(git branch --list:*), Bash(git branch --show-current), Bash(git branch -a), Bash(bash .claude/scripts/npm-checks.sh:*), Bash(bash .claude/scripts/pr-for-branch.sh:*), Bash(bash .claude/scripts/pr-locality.sh:*), Bash(rm suggestions.md)
disallowed-tools: Edit(.git/**), Edit(./.git/**), Edit(.git), Edit(./.git), Edit(.claude/**), Edit(./.claude/**), Edit(.remember/**), Edit(./.remember/**), Edit(.github/**), Edit(./.github/**), Edit(.vscode/**), Edit(./.vscode/**), Edit(android/**), Edit(./android/**), Edit(docs/**), Edit(./docs/**), Edit(e2e/**), Edit(./e2e/**), Edit(ios/**), Edit(./ios/**), Edit(public/**), Edit(./public/**), Edit(src/**), Edit(./src/**), Edit(.editorconfig), Edit(./.editorconfig), Edit(.gitattributes), Edit(./.gitattributes), Edit(.gitignore), Edit(./.gitignore), Edit(.nvmrc), Edit(./.nvmrc), Edit(.prettierrc), Edit(./.prettierrc), Edit(AGENTS.md), Edit(./AGENTS.md), Edit(CLAUDE.md), Edit(./CLAUDE.md), Edit(README.md), Edit(./README.md), Edit(angular.json), Edit(./angular.json), Edit(capacitor.config.ts), Edit(./capacitor.config.ts), Edit(eslint.config.js), Edit(./eslint.config.js), Edit(ionic.config.json), Edit(./ionic.config.json), Edit(package-lock.json), Edit(./package-lock.json), Edit(package.json), Edit(./package.json), Edit(playwright.config.ts), Edit(./playwright.config.ts), Edit(tsconfig.app.json), Edit(./tsconfig.app.json), Edit(tsconfig.json), Edit(./tsconfig.json), Edit(tsconfig.spec.json), Edit(./tsconfig.spec.json), Edit(.npmrc), Edit(./.npmrc), Edit(npm-shrinkwrap.json), Edit(./npm-shrinkwrap.json), Edit(vitest.config.ts), Edit(./vitest.config.ts), Edit(vitest.config.js), Edit(./vitest.config.js), Edit(vitest.config.mts), Edit(./vitest.config.mts), Edit(vite.config.ts), Edit(./vite.config.ts), Edit(vite.config.js), Edit(./vite.config.js), Edit(vite.config.mts), Edit(./vite.config.mts), Edit(eslint.config.mjs), Edit(./eslint.config.mjs), Edit(eslint.config.cjs), Edit(./eslint.config.cjs), Edit(prettier.config.js), Edit(./prettier.config.js), Edit(prettier.config.cjs), Edit(./prettier.config.cjs), Edit(prettier.config.mjs), Edit(./prettier.config.mjs), Edit(.prettierrc.js), Edit(./.prettierrc.js), Edit(.prettierrc.cjs), Edit(./.prettierrc.cjs), Edit(.prettierrc.json), Edit(./.prettierrc.json), Edit(karma.conf.js), Edit(./karma.conf.js), Edit(jest.config.js), Edit(./jest.config.js), Edit(**/*.config.js), Edit(**/*.config.cjs), Edit(**/*.config.mjs), Edit(**/vitest.config.ts), Edit(**/vite.config.ts), Edit(**/playwright.config.ts), Edit(**/capacitor.config.ts), Edit(**/*.config.mts), Edit(**/package.json), Edit(**/.npmrc), Edit(**/tsconfig*.json), Edit(**/.prettierrc*), Bash(git push:*), Edit(node_modules/**), Edit(./node_modules/**), Edit(.mcp.json), Edit(./.mcp.json), Edit(.codeindexignore), Edit(./.codeindexignore)
---

Review uncommitted or branch work for **contradictions and self-consistency
issues**, and manage `suggestions.md` at the repository root. Every rule's
argument is in `docs/commands/review-branch.md`.

## Mode selection (do this first)

**Check whether `suggestions.md` exists at the repo root before choosing a
mode.** It is the running record of open issues, so when it is present the
default job is to re-verify it, not to start a fresh review.

| Condition | Mode |
|---|---|
| `suggestions.md` **exists** and `$ARGUMENTS` is empty or `recheck` | **Recheck** (below) |
| `suggestions.md` **missing** and `$ARGUMENTS` is empty | **Full review** — branch vs `main` |
| `$ARGUMENTS` is `full` or `full --local` | **Full review**, even if `suggestions.md` exists (replace the file from scratch after the new pass) |
| `$ARGUMENTS` is `--local` only, no `suggestions.md` | **Full review** of the working tree |
| `$ARGUMENTS` is `--local` and `suggestions.md` exists | **Recheck** first; do not silently switch to a full local sweep unless the user also passed `full` |
| `$ARGUMENTS` is `recheck` and `suggestions.md` **missing** | Stop: say there is nothing to recheck and offer a full review |

An explicit `recheck` is kept for clarity; the file's presence beats an empty
argument list.

## What counts as a finding

The bar is **two statements that cannot both be true**, or a statement that
cannot be true of the system described — not style taste. (why:
docs/commands/review-branch.md, *What counts as a finding*) Prefer:

1. **Document ↔ code drift** (samples, pins, type names, provider order,
   endpoints, ports, credentials). The spec's §11 and
   `docs/client-architecture.md` make the checkable claims; read §12 before
   treating a spec claim as settled.
2. **Cross-document / CLAUDE.md contradictions** — two rules that cannot both
   be true, or a planned tree stated as present. Not a pre-existing count or
   second copy this branch left untouched (`docs/change-locality.md` §2); one
   this branch **introduces or edits** is a finding.
3. **Pin drift** — `package.json` vs `package-lock.json` vs the spec's §11 and
   the plan's *Versions* table; a package imported and pinned nowhere; a peer
   range the lockfile did not resolve to.
4. **Native and CI drift** — `capacitor.config.ts`, `android/**`, `ios/**` or
   `.github/workflows/ci.yml` against the spec's §8 and
   `docs/client-architecture.md` §15. Lint, the unit suite and the web build
   cover none of it.
5. **Incomplete reconciliation** — a rule this change states (or a fix it
   claims) that the corpus still violates in the same change set.
6. **A file outside the declared touch set.**
   `bash .claude/scripts/pr-locality.sh <n>` — `<n>` from
   `bash .claude/scripts/pr-for-branch.sh` — prints one `class` line and one
   `inside <path>` or `outside <path>` line per changed file, and never the
   rows. Each `outside` line is a finding; its resolution is a narrower diff,
   a row widened with its reason beside it when the path is inside the class's
   tree set, or a different class when it is not — never a row widened
   silently (`docs/change-locality.md` §3). Where the helper prints nothing or
   cannot run — a `--local` review with no PR yet, or a body carrying neither
   row — say so and skip the check rather than inferring a class. **Nothing enforces the touch set here** (the locality gate was not
   ported), so a skipped verdict leaves the rows unverified. **The verdict
   narrows and grants nothing.**

Reject as non-findings the house styles `docs/style-guide.md` tabulates on
purpose, and the stale restatements `docs/change-locality.md` §2 leaves in
place.

## Recheck mode

**Trigger:** `suggestions.md` is present, or `$ARGUMENTS` contains `recheck`.

1. **Read `suggestions.md` in full** and enumerate every numbered issue. If it
   is empty or has none, say so and offer a full review.
2. **For each issue, independently:** locate the sites under **Where** /
   **File** (grep siblings if lines moved), verify the **Problem** still holds
   against the current tip, and set status to exactly one of **fixed**,
   **open**, **correct** (owner accepted it, only if the file or the user said
   so) or **false positive** (the claim never held).
3. **Do not invent new issues**, except a direct regression of a listed item
   (same claim, broken in a new place). A sweep for new findings is `full`.
4. **Rewrite `suggestions.md`:** update the status table and every **Status**
   line, keep fixed items briefly so the next recheck has context, and bump
   **Re-checked:** to today's date.
5. **If every issue is fixed, correct or false positive:** delete
   `suggestions.md` and report all closed, one line of evidence per issue.
6. **If any remains open:** keep the file and report counts.

## Full review mode

**Trigger:** no `suggestions.md`, or `full` / `full --local`.

1. **Establish the range.** Branch: `MERGE_BASE=$(git merge-base origin/main
   HEAD)` (fall back to `main`), then `git diff --stat` / `--name-only` / the
   full diff `"$MERGE_BASE..HEAD"` and `git log --oneline "$MERGE_BASE..HEAD"`.
   `--local`: `git status --short` and `git diff HEAD`.
2. **Read the change.** Prefer load-bearing files whole over the diff. Grep
   `src/`, `e2e/` and `docs/` for every symbol it touches and the one spec
   section or `docs/client-architecture.md` argument that owns a rule it moved.
   Do not tour the corpus: a stale restatement outside the touch set is not
   this branch's to fix (`docs/change-locality.md` §2).
3. **Run cheap gates when the range touches them:**
   `bash .claude/scripts/npm-checks.sh [all|fast|lint|test|build]` when it
   touches `src/` or a file the toolchain reads. **The Playwright suite is
   nobody's gate here**: `npm-checks.sh` has no `e2e` mode, CI's `e2e` job is
   where it runs, and the report says it was not run.
4. **Author findings only when verified.** Quote the conflicting sites.
   Severity: **bug** | **suggestion** | **nit**.
5. **Write `suggestions.md` at the repo root** when any issue is open. Shape:

   ```markdown
   # Suggestions — branch vs `main`   # or "local uncommitted"

   **Reviewed:** <ISO date>
   **Branch:** <name>
   **Base:** origin/main @ <short sha>
   **Scope:** <one line>
   **Diff:** <N files, +/- lines>

   ## Overall
   <2–4 sentences>

   | # | Severity | Item | Status |
   |---|---|---|---|
   | **1** | bug | … | open |

   ## Bugs / Suggestions / Nits
   ### 1. …

   | | |
   |---|---|
   | **Where** | … |
   | **Status** | open |

   **Problem.** …
   **Suggestion.** …

   ## What looks good (no action)
   …

   ## Recommended fix order
   …
   ```

6. **If nothing is open**, do not create `suggestions.md`; with `full` and an
   old file, delete it when the pass is clean and replace it when it has
   findings.
7. **`suggestions.md` is working state.** Never commit it or add it to the
   index; say so if the user is about to ship.

## Report (chat)

Always end with: the mode actually run (**recheck** or **full**, and
branch/base or local); whether `suggestions.md` was present at start; issue
counts by status; the path to `suggestions.md` if kept, or that it was deleted
or not created; and the top remaining findings, one line each.

**Do not fix the findings in this command** unless the user explicitly asks
after the review. This is enforced by the frontmatter's `disallowed-tools`
(every tracked tree and root file, the names the toolchain loads unasked, and
`node_modules/`), not by this sentence; a redirection on a granted `Bash`
command is the residual. (why: docs/commands/review-branch.md, *Why the
command cannot fix findings*)
