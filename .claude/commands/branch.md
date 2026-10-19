---
description: Start a correctly named working branch — in its own worktree under .claude/worktrees/ from a clean main, in place when the tree is dirty or that directory is not writable
argument-hint: "[what the change does] — omit to derive it from the uncommitted work"
allowed-tools: Read, Grep, EnterWorktree, Bash(git status:*), Bash(git diff:*), Bash(git branch --list:*), Bash(git branch --show-current), Bash(git branch -a), Bash(git log:*), Bash(bash .claude/scripts/git-fetch-origin.sh:*), Bash(bash .claude/scripts/git-branch-create.sh:*), Bash(bash .claude/scripts/git-worktree-fork.sh:*), Bash(bash .claude/scripts/git-switch-existing.sh:*), Bash(git rev-parse:*), Bash(git worktree list:*), Bash(ls:*)
---

Create a branch for: $ARGUMENTS — if empty, derive it from the uncommitted
work. Every rule's argument is in `docs/commands/branch.md`.

`main` is not a working branch. Work already started on it is moved off here,
and uncommitted changes follow a `checkout -b`, so nothing is stashed.

## A branch is a workspace, not a HEAD

**A new branch gets its own worktree under `.claude/worktrees/<slug>`, and the
session moves into it.** The two exceptions, a dirty `main` and a
`.claude/worktrees/` that is not writable, branch in place. (why:
docs/commands/branch.md, *A branch is a workspace, not a HEAD*)

- The directory is load-bearing: it is the one place `EnterWorktree` enters
  without a relocation prompt, and `.gitignore` carries it.
- The slug is the first word or two of the kebab summary, without the
  `<type>/` prefix or a feature's scope word: `feat/template-masstransit-
  registration` gives `masstransit`.
- A worktree carries committed files and a seeded copy of the code index,
  nothing else untracked; say so if that stops being true.
- The sweeps fork detached worktrees under `mktemp -d` on purpose; do not
  reconcile the two.

## Steps

0. **Ask whether this is already an isolated workspace:**

   ```bash
   git rev-parse --git-dir --git-common-dir --show-superproject-working-tree
   ```

   The first two differing, with no superproject, means the session is in a
   linked worktree. That is this change's workspace, so step 5 forks nothing;
   report its path and branch, and carry on into step 1, which still reads
   the branch.
1. **Read the current state:** `git branch --show-current` and
   `git status --short`. Four cases:
   - **On `main`, clean:** fetch, then cut from `origin/main`. Normally a
     worktree.
   - **On `main`, dirty:** branch in place from `HEAD`, carrying the changes;
     say so. A stash or patch is refused, and an in-place branch forgoes the
     worktree for good. Attaching one later is the user's:

     ```bash
     git switch main
     git worktree add .claude/worktrees/<slug> <branch>
     ```

     then `EnterWorktree` on the new path.
   - **Detached** (nothing printed): make a branch from `HEAD` with
     `bash .claude/scripts/git-branch-create.sh <name> HEAD`, carrying any
     changes; the workspace is this directory.
   - **Already on a branch:** stop. Report the branch, its upstream, its
     worktree and whether the tree is dirty, and ask whether this is a second
     change or a continuation. Never branch off a feature branch unasked.
2. **Derive the description if none was given** from `git status --short`,
   `git diff`, `git diff --stat` and the untracked files. The type follows
   what was touched:

   | | |
   |---|---|
   | `docs/**` only | `docs/` |
   | `.editorconfig`, `.prettierrc`, `eslint.config.js`, `CLAUDE.md`, `.claude/**`, CI, `package.json` | `chore/` |
   | `src/**` or `e2e/**` | `feat/<scope>-`, `fix/` or `refactor/` — the diff decides which |
   | `android/**`, `ios/**`, `capacitor.config.ts` | `feat/native-` or `fix/` — the diff decides which |

   A mixed tree takes the type of the change that carries the argument, not
   the one with the most files. Two unrelated changes cannot both be in the
   name: name the dominant one and flag the other. A clean tree with no
   argument means stop and ask.
3. **Name it `<type>/<kebab-summary>`**, a feature
   `feat/<scope>-<kebab-summary>`; the type is the one the commit will carry:

   | | |
   |---|---|
   | `docs/` | Spec and architecture prose, structure, cross-references |
   | `chore/` | Repo config — linters, `CLAUDE.md`, commands, CI, pins |
   | `feat/<scope>-` | Application code that adds behaviour |
   | `fix/` | A defect in either |
   | `refactor/` | Shape change, no behaviour change |

   Established names to match: `fix/emulator-cleartext-gate`,
   `ci/android-selector`. Summarise the change, not the files:
   `fix/cart-total-rounding`, not `fix/update-cart`. **The scope is a word of
   its own ahead of the summary and never a parenthesis**: the push guard
   admits only a plain ref (`SAFE_REF` in `.claude/hooks/guard-git-argv.py`),
   `git branch -m` is denied, and a refused name can only be abandoned.
   (why: docs/commands/branch.md, *Steps*) A task from the plan under
   `docs/superpowers/plans/` takes its `## Task n:` heading:
   `Cart store and persistence` → `feat/cart-store-and-persistence`.
4. **Check the name and the directory are free:** `git branch --list`,
   `git branch -a` and `git worktree list`. A name that exists locally or on
   the remote means the work may be underway; say so rather than picking a
   variant. On the one path that uses the directory, the clean-`main` fork,
   also look at the path itself:

   ```bash
   ls -d .claude/worktrees/<slug>
   ```

   Anything already there, registered worktree or not, stops the command:
   report which and ask. The other three paths never touch it.
5. **Create the workspace, then move into it.**

   | Step 1 said | This step does |
   |---|---|
   | On `main`, clean, in the main checkout with a writable `.claude/worktrees/` | Both halves — fork the worktree, enter it |
   | On `main` clean, but **already in a linked worktree** (step 0) | `bash .claude/scripts/git-branch-create.sh <name> origin/main` here. The workspace exists; forking a second is what step 0 refused |
   | On `main` clean, `.claude/worktrees/` not writable | `bash .claude/scripts/git-branch-create.sh <name> origin/main` where you are |
   | On `main` dirty, or **detached** | `bash .claude/scripts/git-branch-create.sh <name> HEAD` — the point is to carry what is in this tree |
   | Already on a branch | Nothing — step 1 stopped |

   A skipped fork is never a skipped branch. Every clean-`main` row cuts from
   `origin/main`, never local `main`; the dirty and detached rows stay on
   `HEAD`. From a clean `main` at the main checkout's root, both halves are
   one helper:

   ```bash
   bash .claude/scripts/git-worktree-fork.sh .claude/worktrees/<slug> <name>
   ```

   It runs `git worktree add --no-track -b <branch> <path> origin/main` and
   starts the new worktree's index refresh. `--no-track` is load-bearing:
   without it the upstream lands on `origin/main` and `/pr` never sets the
   right one. Then **`EnterWorktree`** with the new directory as `path`;
   everything after runs there.

   **A new worktree has no `node_modules`.** Run `npm ci` once after moving
   in, never `install`, and again after a lockfile change;
   `npm-checks.sh` refuses a worktree without it.

   **If the fork fails, read the message before falling back.** Fall back to
   an in-place branch only when git says it could not create leading
   directories for permission reasons; anything else stops the command and
   is reported verbatim. Then check whether the branch survived the failed
   fork:

   | After the failed fork | Take |
   |---|---|
   | `git branch --list <name>` prints it | `bash .claude/scripts/git-switch-existing.sh <name>` — it is already cut from `origin/main` and untracked, which is what the fork asked for |
   | It prints nothing | `bash .claude/scripts/git-branch-create.sh <name> origin/main` |

   All three git operations go through helpers because a raw grant would also
   buy `-B`, `-C` or a trailing `-f`; the helpers fix every flag and
   shape-check their arguments. **If the session cannot enter a worktree that
   was created, stop and report the path**; do not issue `git -C` commands
   against a directory the session is not in, and leave the worktree
   standing. No upstream is set either way: `/pr` does that on the first push.

## Report

The branch created, what it was cut from, **the worktree it lives in and
whether the session is now inside it**, and the files carried across if the
tree was dirty. The workspace gets its own line even when none was created,
and an in-place branch says why. Nothing here removes a worktree.

**A derived name is a guess, so show the work:** say no description was
passed, give the one-line reading of the diff the name came from, and say the
name can change until `/pr` pushes — by a second branch at the same commit,
`bash .claude/scripts/git-branch-create.sh <better-name> HEAD`, naming the
first in the report rather than deleting it.
