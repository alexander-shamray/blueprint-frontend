# Change locality — the operating contract

How an agent works this repository so that a fix or a small feature touches
its own slice and nothing shared, so that code is the source of trust, and so
that several agents can run at once, including inside one area, without
meeting in the same file.

This file does not replace the spec. Where a spec section and compiled code
with green tests disagree about a **fact**, the code is right, and
[`client-architecture.md`](client-architecture.md) §12 is where that is
recorded rather than argued twice. A document is amended when a **rule**
moved, never to restate a fact the code already owns.

## 1. Source of trust, in order

A lower layer cites a higher one by name. It never copies the value.

1. **Gates and tests.** Green means the claim they cover is true. Here that
   is `npm run lint`, the Vitest suite, the Playwright smoke, and the
   `android` job's two-direction assertion of the emulator relaxations.
2. **Code.** Types, providers, guards, interceptors, environment files,
   route definitions, the ESLint boundary rules. A value a document needs
   lives in one named symbol; the document names the symbol.
3. **[`docs/client-architecture.md`](client-architecture.md)** — "The
   client's arguments", §1–§15. One numbered section per decision, each
   starting from a fact somebody else decided and ending at the file here
   that answers it. This is the repository's ADR trail: sections are
   superseded in place with the old claim kept, never silently rewritten.
4. **The design spec**, `docs/superpowers/plans/`'s companion at
   [`docs/superpowers/specs/2026-09-10-blueprint-frontend-design.md`](superpowers/specs/2026-09-10-blueprint-frontend-design.md)
   — §1–§11, the rule and the reason. **It is outranked by §3 wherever
   `client-architecture.md` §12 says so**, and §12 exists precisely because
   execution found several of the spec's claims untrue. Read §12 before
   citing a spec section as settled.
5. **Git.** The commit body argues the change, the PR body is the house form,
   `git log` and `gh pr list` are the index. This is the change record.
6. **`CLAUDE.md`** and the files it points at. How to act here. Nothing that
   moves when a PR lands.

**`docs/superpowers/plans/` is a delivery record, not a specification.** Tasks
0–20 are complete; the plan states what was built and in what order, and it is
cited for a task's title and its order, never as the current truth about the
code. Do not edit it to match what the code became — that is §12's job.

## 2. The rule

**Every fact has exactly one owner, and every other mention cites the owner.**
A document may say "the rate-limit window is `rate-limit.ts`'s, keyed per
route (`client-architecture.md` §10)". It may not say "sixty seconds" unless
it is the file that defines sixty seconds.

So a change to a fact is one edit plus a search for the **symbol**, not a
search for the value across the corpus. The obligation to reconcile every
restatement is withdrawn. If you meet a stale restatement while doing
something else, leave it: removing restatements is its own change, and fixing
one in passing widens your touch set for no gain.

Never write, in any document:

- a number of tests, specs, components, routes or lines;
- a package version outside `package.json` and `package-lock.json`, except
  in the spec's §11 and the plan's *Versions* table, where the version
  itself is the decision, as Class E says;
- a timeout, retry count, port, TTL, window or bundle budget as a raw
  integer in a second place — the budgets live in `angular.json`, the
  windows in `src/app/core/errors/`, and a document names the symbol;
- "since PR-NN", "this used to say", or the history of how a rule was
  corrected. `client-architecture.md` is the history.

A measurement is not a restatement. A commit body, a PR body or an issue may
state a count or a value **as of a named date or commit**, because a record of
what was true when it was taken is not a claim that it is true now, and
nothing has to keep it current. `client-architecture.md`'s own header does
exactly this — it names the backend commit it was checked against. The
prohibition is on a document stating a fact in the present tense in a second
place.

## 3. Change classes

Name the class and the touch set before editing. Do not grow the set "just in
case". A file the work turns out to need is one of two things: inside the
class's tree set, in which case it is **added to the row with its reason
beside it** — a review found it, a test needed it — and the widening is on the
record rather than rewritten out; or outside the class's tree set, in which
case the class is wrong, so change the class, not the set. A change that
genuinely needs two classes names both — `C+E` for a rule that brings a
package, `A+D` for a feature change whose native config moved — and its touch
set is the union.

**There is no locality gate in CI here, and that is a gap rather than a
decision.** The repository these commands came from carries
`.github/locality-gate/`, which reads the classes from one file and fails a PR
on a path outside either set. Nothing here does. What stands instead is
`bash .claude/scripts/pr-locality.sh <n>`, which `/review-branch`,
`/review-copilot` and `/ship` run against an open PR and which prints one
`inside`/`outside` verdict per changed path — a check somebody runs, not one
that runs itself. Porting the gate is a follow-up worth having. Until then the
table below is the owner of what each class may reach.

| Class | Examples | May touch | Never touches |
|---|---|---|---|
| **A — local** | fix a page's rendering, tighten a spec, add a form field the wire type already has, correct a label | one feature slice, `src/app/features/<name>/**`, and its `.spec.ts` files; the one `e2e/` step if the flow's visible steps changed | any other feature — the ESLint boundary refuses the import, and a change that wants one is not this class; `src/app/core/**`; any document; `CLAUDE.md`; the harness |
| **B — shared mechanism** | change the error mapper, the rate-limit window, the auth interceptor, the cart store's persistence, a `shared/` component | one area under `src/app/core/<area>/**` or `src/app/shared/**`, and its specs; the *one* feature spec that proves the wiring; `src/app/core/boundaries.spec.ts` when the import rules themselves moved; the one `client-architecture.md` paragraph that states the rule | every section that *mentions* the mechanism; two core areas in one PR; the spec; the plan |
| **C — a rule moved** | a guard must refuse where it admitted; a 409 gains a third meaning; the client may now compute something it could not | code and specs; one new or superseded `client-architecture.md` section; the single spec section that section amends; Class E's set beside it, as `C+E`, when the rule brings a package | every historical paragraph describing the old rule — the new section is the correction and the spec points at it; the plan; `CLAUDE.md` |
| **D — docs or harness** | a new `/command`, a style pass, a CI job, a native manifest change, this contract | only the documents, `.claude/**`, `.github/**`, `android/**`, `ios/**` or `e2e/**` tree the issue names, `CLAUDE.md`, and the repository's own configuration files at the root — or, when no issue was filed, the paths the touch-set row declares | inventories "while we are here"; application code |
| **E — dependency graph** | add a package, raise a pin, add a path alias | `package.json` and `package-lock.json` together, always — the pin exact; `angular.json` and `tsconfig.json` when a path alias or a budget moved; the spec's §11 and the plan's *Versions* table, where the version is the decision | the sections that use the package |

Notes that decide the edge cases:

- **Crossing two features in one PR is not Class A and it is not Class B
  either** — it is the import boundary telling you the shared part belongs in
  `core/`. `eslint.config.js` refuses the import and
  `src/app/core/boundaries.spec.ts` is the precise check; read that file's
  comment before deciding the rule is wrong.
- **`src/app/app.routes.ts`, `src/app/app.config.ts` and
  `src/app/tabs/tabs.page.ts` are the composition roots**, and a Class A
  change that has to edit one has outgrown its class. Adding a route for a
  new feature is Class B for the routing surface.
- **A `.spec.ts` is not a separate slice.** It belongs to the file it covers
  and moves with it, in the same PR (§6).
- **`capacitor.config.ts` is native configuration and web configuration at
  once**, which is why it is a repo-wide mutex below. A change to it plus a
  feature change is `A+D`, never Class A with a quiet extra file.
- **`package.json` and `package-lock.json` move together or not at all.** A
  lockfile edited without the manifest — or the reverse — is the drift `npm
  ci` fails on, and it fails in CI rather than locally.
- **`android/` and `ios/` are committed, not generated here.** CI compiles the
  same manifest a developer edits (`ci.yml`'s `android` job says so in as many
  words), so a regenerated project is a diff somebody has to read, not a
  refresh.

## 4. Parallel work

### Partitions

One worktree and one branch per agent, via `/branch`. Safe to run at once:

| Agent owns | Notes |
|---|---|
| one slice under `src/app/features/**` and its specs | six exist: account, cart, checkout, order-placed, products, publish |
| one area under `src/app/core/**` and its specs | never two agents on `core/errors` or `core/auth` at once |
| `src/app/shared/**` | one agent only; every feature imports it |
| one of `.github/**`, `android/**`, `ios/**`, or one document under `docs/` | one document per agent |
| `.claude/**` | one agent only: `settings.json` self-locks and `ship.md` is one file |

### Two agents inside one area

Safe when neither needs the same mutex. The mutexes are:

- `src/app/app.config.ts` — the provider composition root;
- `src/app/app.routes.ts` and `src/app/tabs/tabs.page.ts` — the routing surface;
- `src/app/core/config/environment*.ts` — one agent per environment change;
- `src/app/core/api/types.ts` — the wire types every client reads;
- `src/vitest-setup.ts` and `e2e/smoke.spec.ts`.

A new component, service or guard needs none of those five. Say in the issue —
or in the touch-set row, when there is no issue — which mutex a task needs. Do
not start a second agent on the same one.

### Repo-wide mutex surfaces

Edited by one agent at a time, and named in the issue — or in the touch-set
row, when there is no issue — when a task needs one:

```
package.json                    package-lock.json
angular.json                    tsconfig.json / tsconfig.app.json / tsconfig.spec.json
eslint.config.js                .prettierrc                    .editorconfig
capacitor.config.ts             .github/workflows/ci.yml
src/app/core/api/types.ts       src/app/app.config.ts
```

`capacitor.config.ts` is on that list for a reason worth stating: it is the
one file that decides what `cap sync` writes into `android/` and `ios/`, both
of which are committed. Two agents editing it produce a conflict in three
trees rather than one.

## 5. The procedure

What an agent does instead of touring the corpus:

1. Read the issue. Name the class and the touch set before the first edit —
   in the issue, or in the first commit's body when there is none — and copy
   them into the PR body's `| Class |` and `| Touch set |` rows when `/pr`
   opens it, with any file added mid-work and its reason (§3). Nothing in CI
   reads that pair; `pr-locality.sh` is what does, when somebody runs it.
2. Search **code** for the symbol: `rg` over `src/` and `e2e/`.
3. Open the owning `client-architecture.md` section only for Class B or C,
   and only the paragraph that states the rule. Open the spec only to cite
   it, and read §12 first in case execution already overrode it.
4. Write the test first, then the change.
5. Run the smallest gate that can fail for this class:
   `bash .claude/scripts/npm-checks.sh fast` for anything under `src/`,
   `all` before the PR opens. [`testing.md`](testing.md) has the rest,
   including what the Playwright suite needs that a laptop does not have.
6. After a change to `capacitor.config.ts`, `android/**` or `ios/**`, say
   plainly that the `android` job is the check and that it runs in CI — lint,
   the unit suite and the web build cover none of it.
7. Commit with `/commit`; the body argues the change and, when the change
   closes an issue, carries a bare `Closes #n` line. Open the PR with `/pr`.
8. In the review loops, a finding that asks for a restated count, a
   "since PR-NN" sentence, or a corpus-wide rename of something whose owner
   site is already correct is answered by citing this file, not by editing.
9. Stop. Do not open `CLAUDE.md` looking for a sentence that still names the
   old type.

## 6. What still applies

Locality waives one rule: that every mention of a fact must be rewritten in
the same PR. It waives nothing else. In particular:

- specs ship in the same PR as the code they cover;
- exact pins in `package.json`, with `package-lock.json` in the same commit;
- the import boundaries: a feature never imports another feature, and `core`
  knows nothing about screens (spec §3), enforced by `eslint.config.js` and
  proved by `src/app/core/boundaries.spec.ts`;
- the dialect in [`style-guide.md`](style-guide.md): British prose,
  identifiers keep their real spelling, 80-column prose, 100-column code;
- `client-architecture.md` sections superseded with the old claim kept, never
  rewritten;
- `main` stays green;
- when a change closes an issue, `Closes #n` as a bare line, not only inside
  a table cell;
- a kind label and a severity label on every issue;
- no real credentials, in a sample or in source; the local-development
  defaults the spec names are the one stated exception;
- the harness boundaries in [`harness-boundaries.md`](harness-boundaries.md)
  before touching anything under `.claude/`.

## 7. Checklist

```
[ ] Class named (A/B/C/D/E) in the PR body
[ ] Touch set listed there; nothing outside it is edited
[ ] Symbol searched in src/ and e2e/, not the value in docs/
[ ] client-architecture.md paragraph opened only for Class B or C, and §12
    read before citing a spec section
[ ] Test written first; npm-checks.sh fast green, and all before the PR
[ ] A native change names the android job as its check, and says it runs in CI
[ ] A client-architecture.md section appended or superseded only if a rule
    moved; nothing in it rewritten
[ ] No present-tense count, version or raw value written outside its owner;
    no "since PR-NN"
[ ] The spec, the plan, style-guide.md, testing.md and CLAUDE.md untouched
    unless the class names one
[ ] Mutex surfaces this PR needs are named in the issue, or in the touch-set
    row when there is none
```
