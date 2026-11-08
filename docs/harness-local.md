# Harness-local: blueprint-frontend

What the payload's commands name by role, filled in for this repository.
The four headings are fixed by the payload's `docs/harness-boundaries.md`,
*Managed files*; this file is the repository's own and no sync writes it.

## Documents

| Role | Path |
|---|---|
| Change contract | `docs/change-locality.md` |
| Style guide | `docs/style-guide.md` |
| Testing document | `docs/testing.md` |
| Product specification | `docs/client-architecture.md`, then the design spec `docs/superpowers/specs/2026-09-10-blueprint-frontend-design.md` |
| Roadmap | none |
| Closed records | `docs/superpowers/plans/` |
| Measurements | `docs/token-usage.md`, read through `docs/token-plan.md` |

The change contract's classes are its §3 and its procedure, the touch set
included, its §5; the class map is `.github/locality-gate/classes.yml`,
which §3 cites. `docs/client-architecture.md` outranks the design spec
wherever its §12 says so (`CLAUDE.md`, *Precedence*). The delivery plan under
`docs/superpowers/plans/` is a record, never edited to match the code, so it
is the closed records; the design spec beside it is amended and is not. The
sweeps' `sweep-slices.sh` counts all of `docs/superpowers/` as one closed
slice, the spec included.

## Ship checks

Selected by what the diff touched:

- **`bash .claude/scripts/npm-checks.sh all`** — lint, the unit suite and
  the production build — whenever the change reaches `src/**`, `e2e/**` or a
  file the toolchain reads (`package.json`, `angular.json`, `tsconfig*.json`,
  `eslint.config.js`, `.prettierrc`). A docs-only change runs `fast` or
  nothing and says which. **A new worktree has no `node_modules`**: run
  `npm ci` there once first, since the helper refuses a checkout without its
  own install rather than resolve packages from the main checkout's.
- **The Playwright suite is CI's and is not run here**: it needs the
  backend's Compose stack and a browser (`docs/testing.md`), and the `e2e`
  job runs it. The PR body says plainly that it was not run.
- **A native change is covered by no local check**: a diff touching
  `capacitor.config.ts`, `android/**` or `ios/**` names the `android`,
  `ios-config` and `ios-build` jobs in the PR body, which run in CI.
- **A change under `.claude/`** runs the harness's own suite,
  `py -3.12 -m unittest discover -s .claude/scripts`, and the local suites
  among it (`test_*_frontend.py`, `test_npm_checks.py`, `test_mcp_launch.py`,
  `test_root_ignore_coverage.py`) whatever else it touched.

The checks `/ship` step 6's wait requires: `android`, `audit`, `closure-gate`,
`commit-gate`, `commits`, `e2e`, `harness (macos-latest)`,
`harness (ubuntu-latest)`, `harness (windows-latest)`, `harness-drift`,
`ios-build`, `ios-config` and `web`. `rulesets/main.json` in `blueprint-harness`
owns what the `main` ruleset requires. A check joins this list before it joins
that file, so `/ship` never waits on a list short of the ruleset.

## Residuals

Seven passages the managed `docs/harness-boundaries.md` no longer carries
live here, because only this repository's tree or toolchain makes them true.
The harness's `IMPORT.md`, *Frontend audit, pinned at 41a3f45*, cluster F,
names each one's source line in this repository's copy before the first
sync. Their arguments are kept; where a paragraph named a file the sync
dropped, it now names the file that holds the case.

**A bare `#NN` under `.claude/` or in `docs/harness-boundaries.md` is an
issue in `alexander-shamray/blueprint-backend` or the harness, not one
here.** The machinery was built over there and its arguments are kept
verbatim, so chase such a number there or not at all. Where a paragraph
argues from something measured over there — an `Exec` in an auto-imported
MSBuild file, a grant withdrawn from a command this repository does not have
— the measurement stands and the toolchain in it does not.

**Nothing structural catches the boundaries file's drift here.** The two
commands that audit documents in backend, `/validate-blueprint` and
`/check-links`, read a blueprint tree this repository does not have and were
not ported, so no command here reads that file, and the sync's drift gate
holds only that it equals the payload. The one rule in `CLAUDE.md` covers
this file and the documents it names, and that is all that does.

**A filled launcher mark refuses every call while `git status` stays
clean.** `run-guard.sh` remembers the interpreter it proved under
`.claude/cache/`, and `.gitignore` here ignores only
`.claude/cache/codebase-index/`, not the whole of `.claude/cache/`. An empty
mark is invisible to git all the same. A mark something was put inside is the
state that refuses every call, and git need not show it: an empty directory
inside it, a name another rule ignores such as `__pycache__/`, or a file a
branch committed there all leave `git status` clean. What does find it is
the refusal, which names the mark's path.

**An unattended push was refused under auto mode, and the cause is not
established** (backend #33's shape). On three branches in a row —
`fix/tabs-teardown-race`, `fix/late-browser-finished` and
`fix/cart-line-validation` — `git push -u origin <branch>` was refused with
the harness's "has been denied" text and no hook reason, while
`guard-git-argv.py`, run on the same event, allowed it. The documentation
says auto mode keeps a narrow allow rule like this one, which resolves before
the classifier is consulted
([permission modes](https://code.claude.com/docs/en/permission-modes.md)).
The standing inference is the classifier reading an `autoMode.environment`
block that names only the backend's remote as trusted source control;
nothing has measured it. What is established is the outcome: under that
setup the project grant does not deliver an unattended push, `/pr` and
`/ship` name a refused push as a stop with the manual line, and the remedy
that does not route around a refusal is a user-level one — naming this
repository and its `origin` as trusted source control in
`autoMode.environment`.

**A build configuration that does not exist yet escapes any deny
enumerated from the tree, and this toolchain makes that sharper, not
milder.** `eslint.config.js` and a `vitest.config.ts` are JavaScript that is
executed in order to be loaded; `.npmrc` can set `script-shell`; a
`pre`/`post` entry in `package.json` runs on every `npm` invocation. The
grant that would have bought it — `Bash(npm run:*)` — admits any script the
manifest names, including one a command has just written, and `npm test --
--config <path>` admits a file Vitest executes to read. None of those is
granted: the executor is `npm-checks.sh`, whose only variable is one word
out of a closed set, and `test_npm_checks.py` asserts that no command's
`allowed-tools` grants a package runner or an interpreter — `npm`, `npx`,
`node`, `ng`, `yarn`, `pnpm`, `bun`, `deno`, `python` or `pip` in any
version, a wrapper (`env`, `command`, `exec`) that runs whichever program
follows it, or a `py` not pinned to a script under `.claude/scripts/` or to
the unittest runner. It judges each grant by its program word, through a
path, a Windows shim suffix, an environment assignment or a wrapper: the
house form `Bash(npx:*)` never matched the prefix `Bash(npx ` the check
first looked for (blueprint-frontend#375). The helper closes the executor and
not the manifest, so the auto-load names are denied as well in
`/review-branch`, the one local command that states an editing boundary, and
`test_review_branch_frontend.py` holds that list. The exact filenames are
measured; a glob beside them in a `disallowed-tools` value is not. One
interpreter grant stays open, and the check exempts it by name:
`Bash(py -3.12 -m unittest discover:*)` in the managed `ship.md` takes any
`-s <dir> -p <file>`, so it runs a test file written anywhere, a scratchpad
included, where `npm-checks.sh test` runs only specs the diff shows. Narrowing
it is the payload's, and blueprint-harness#223 tracks it.

**`eslint.config.js` and `.prettierrc` stay editable, and the checks run
them.** They are not in `.harness/config.json`'s denies, because
`/style-pass` edits both as its job and a deny in settings beats a command's
own allowance; `eslint.config.js` is JavaScript `npm-checks.sh lint` runs, so
it is the residual. It is accepted, as blueprint-frontend#224's decision
(2026-10-17): closing it would take a way for `/style-pass` to write these
two files that no other command can, and a flat deny list cannot say "this
command only". The residual needs a session already steered into editing the
linter's configuration and then a run of the checks, and the edit sits in the
diff the reviewer reads. `test_settings_frontend.py` holds the two out of the
list on purpose. Since the first sync the managed runbooks no longer deny
these two, `CLAUDE.md`, `android/**` or `ios/**` in their own frontmatter
either: a managed command has no per-target route for them, so the settings
denies are the whole of what holds.

**A new tool's `.config.ts` stays editable until someone names it.** The
settings denies bind every session: an edit to `package.json`, a `tsconfig`,
`capacitor.config.ts` or `playwright.config.ts` takes the owner's hand, as an
edit to `.claude/**` does. `src/app/app.config.ts`, the composition root,
does not (blueprint-frontend#227): the list names the build configs that
execute — `vitest`, `vite`, `playwright` and `capacitor`, each as
`**/<name>.config.ts` — and not the `.ts` extension, which had matched the
root as it matches a Vitest config. The cost is the one a named list always
has.

**`npm-checks.sh` is granted to every turn, not to four commands.** Before
the first sync the grant sat in the frontmatter of `/ship`, `/pr`,
`/style-pass` and `/review-branch` and lasted their turn; the payload's
`/ship` carries no stack grant and a managed runbook takes no per-target
line, so `.harness/config.json`'s `allow` holds it. Any session that edits a
spec or `eslint.config.js` can now run them unprompted. The executable input
is the same one `/ship` ran before; what widened is when it may run. A
per-command grant the payload could carry would close it, and that is the
harness's to build.

**A shell write is refused where an edit is denied, and nowhere else.** The
git guard this repository had before the sync refused a redirection, `cp` or
`rm` into its own tables of trees and root files. The payload's guard takes
that list from the settings denies instead, so a shell write now reaches
whatever the `Edit` tool already could. The paths that lost the refusal are
those the settings never denied: `android`, `ios`, `.gitattributes`,
`.gitignore`, `.editorconfig`, `.nvmrc`, `ionic.config.json`,
`eslint.config.js` and `.prettierrc`. Nothing became writable that was not,
because `Edit` reached each of them already, and an auto-mode session uses it
as readily as a redirection. `.vscode/**` was on that list and is now denied
(blueprint-frontend#383): `tasks.json` can carry a task VS Code runs on folder
open, and no command edits the tree as its job. The rest stay out on purpose.
`android/**` and `ios/**` are Class D's own work; `.editorconfig`,
`eslint.config.js` and `.prettierrc` are what `/style-pass` edits; and nothing
here executes `.gitignore`, `.gitattributes`, `.nvmrc` or `ionic.config.json`,
so a deny would cost an owner's hand on routine edits and buy nothing. Naming
one in `.harness/config.json` would restore both refusals at once.

**The local suites' reasons live here, because the comment rule keeps them
out of the files** (blueprint-frontend#383). `test_codebase_index_frontend.py`,
`test_npm_checks.py`, `test_review_branch_frontend.py` and
`test_settings_frontend.py` came out of suites the first sync dropped, by the
backend's plan 5 Task 7, and stay local because each reads this repository's
own files, which no payload suite could hold; the harness's `IMPORT.md`,
*Frontend audit, pinned at 41a3f45*, clusters A and F, records it. Each case's
issue: the settings denies exist because `npm-checks.sh` runs `package.json`'s
scripts and the JavaScript configuration on the host while `/ship` holds
`Write`, so a session must not write what it is then told to run
(blueprint-frontend#115); the server starts without a shell because the first
`bash` on a stdio server's Windows PATH is WSL's launcher
(blueprint-frontend#134), and through a Node launcher that judges the index
first (blueprint-frontend#138); the CLI's pin is blueprint-frontend#147 and its
hashed install blueprint-frontend#309. `/review-branch` says "do not fix the
findings" while holding `Write` and `Edit`, and its input is prose in the
branch under review, so its deny list is tested against the tree rather than
against what it contains.

## Review examples

The kinds of finding this repository's surface produces, which
`docs/harness/working-rules.md`, *What counts as a finding*, and the
`branch-reviewer` profile read here. They are the first four of the list the
local `.claude/commands/review-branch.md` keeps in its own *What counts as a
finding*, whose fifth and sixth the working rules already state:

1. **Document ↔ code drift**: samples, pins, type names, provider order,
   endpoints, ports, credentials. The spec's §11 and
   `docs/client-architecture.md` make the checkable claims; read §12 before
   treating a spec claim as settled.
2. **Cross-document / `CLAUDE.md` contradictions**: two rules that cannot
   both be true, or a planned tree stated as present. A stale restatement is
   one only if this branch **introduces or edits** it
   (`docs/change-locality.md` §2).
3. **Pin drift**: `package.json` vs `package-lock.json` vs the spec's §11 and
   the plan's *Versions* table; a package imported and pinned nowhere; a peer
   range the lockfile did not resolve to.
4. **Native and CI drift**: `capacitor.config.ts`, `android/**`, `ios/**` or
   `.github/workflows/ci.yml` against the spec's §8 and
   `docs/client-architecture.md` §15. Lint, the unit suite and the web build
   cover none of it.
