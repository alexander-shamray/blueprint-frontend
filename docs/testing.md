# Testing

What a checkout needs that `package.json` and `.github/workflows/ci.yml`
cannot say.

**This file restates neither.** `package.json` is the list of invocations and
`ci.yml` is the list of jobs; [`client-architecture.md`](client-architecture.md)
§14 owns **what CI runs, and what a red smoke on the development host
means**: the two environmental failures that look like defects and are not.
Read it before concluding a red smoke is a defect. What a local run needs is
the table under *What the Playwright suite needs, and why it is CI's*,
below.
What follows is the rest: the prerequisites, the wrapper, and the three things
that have actually cost time here.

## The invocations

```bash
npm ci                      # from the lockfile, always — never `npm install`
npm run lint                # ESLint over src/ and e2e/, then tsc over e2e/
npm test                    # Vitest, via @angular/build:unit-test
npm run build               # the production bundle
npm run e2e                 # Playwright — see the prerequisites below
npm start                   # the dev server, on 5173
```

Inside a command or a chain, use the wrapper instead:

```bash
bash .claude/scripts/npm-checks.sh [all|fast|lint|test|build]
```

`all` is lint, tests and build in CI's order; `fast` drops the build. The
wrapper exists so that no command has to hold `Bash(npm run:*)`, which would
admit any script the manifest names — its own header argues that, and
`.claude/commands/review-branch.md` argues the other half. **It has no `e2e`
mode on purpose**, for the reason the next section gives.

## Three things hold first

**Node is pinned by `.nvmrc` and the lockfile is the dependency list.** CI
uses `node-version-file: .nvmrc` and `npm ci`. A local `npm install` may
rewrite `package-lock.json`, which then arrives in somebody's review as a diff
nobody chose; `npm ci` cannot, and it also fails loudly when the manifest and
the lockfile have drifted apart, which is the failure worth having.

**A new worktree has no `node_modules`.** It is gitignored, so the worktree
`/branch` forks under `.claude/worktrees/` carries the lockfile and none of
what it pins, and Node's module search and `npm run`'s `PATH` walk up into
the main checkout's `node_modules`, so a check there would run `main`'s
packages. `npm-checks.sh` refuses a worktree with no `node_modules`; run
`npm ci` once after moving in, and again after a lockfile change. The
walk still reaches `main`'s tree for anything the worktree's lacks, so a
dependency dropped from `package.json` but still imported passes locally and
fails in CI.

**The harness suite needs bash, grep, git, jq, **Node** (`test_mcp_launch.py`
runs the MCP launcher; the runners ship it, and `.nvmrc` pins the project's)
and **Python 3.12**.** How you
reach that interpreter is a local choice: `py -3.12` works on Windows and
exists nowhere else, `python` or `python3` elsewhere. **CI does not make that
choice** — `actions/setup-python` puts 3.12 on PATH and the `harness` job runs
`python -m unittest` on all three runners, Windows included, so a developer
reproducing CI runs `python` whatever their platform. **That Python's SQLite
must be 3.37 or later, built with FTS5** (#140): the index-refresh cases build
full-text tables and read `PRAGMA table_list`, and a 3.12 on Linux can be
linked against an older system SQLite. Those cases assert the version in their
set-up, so on such a host every one of them fails there, naming the cause
rather than failing on a missing table; `python -c "import sqlite3;
print(sqlite3.sqlite_version)"` answers before you run anything. The hooks use
`.claude/hooks/run-guard.sh` to select a compatible launcher. **The harness
suite's `setUpModule` fails rather than skips when a tool is missing** — a
skip on a missing tool reports a pass, which is the fail-open it exists to
refuse. The
shell helpers are written for **bash 3.2**, which is what macOS ships as
`/bin/bash`; `grok-ledger.sh`, since archived, used an associative array until
CI's three-OS matrix went red on macOS with `declare: -A: invalid option`.
Nothing had ever run these helpers there. If you add a bash-4 construct —
`declare -A`, `mapfile`, `${var,,}` — the macOS runner is what will tell you.

**On a Windows host, run the harness suite a class per process**
(alexander-shamray/blueprint-frontend#259):
`py -3.12 .claude/scripts/run-harness.py`. Most of a local run is `git` and
Git Bash processes starting, so the classes run side by side — measured at
`bc2d627` on a 24-thread host, 1,236 s serially and 312 s this way. It gives
each class its own temporary directory, because a class asserts what the
shared one holds; runs the classes its `ALONE` set names, whose subject is a
time limit, alone after the rest, because a host busy with every other class
misses those limits for no fault of the code; and fails unless it ran every
test discovery found. **CI keeps `python -m unittest discover`** because it is
the gate — one spelling on all three runners, Windows included, and nothing
between it and the suite — so this is a local convenience and not a second
gate: a case that passes here and fails there is still red.

**The code-index CLI is pinned, here** (alexander-shamray/blueprint-frontend#147).
It is the one tool outside the lockfile that runs unprompted: the MCP server
starts it at every session and the index-refresh hook runs it after every edit
and every shell call, so a changed or compromised PyPI release would reach
every host that installed it unpinned. The version is
`codebase-index==2.0.0`, the release the development host already runs:

```bash
# python -m pip elsewhere
py -3.12 -m pip install --require-hashes \
    -r docs/codebase-index-requirements.txt
```

[`codebase-index-requirements.txt`](codebase-index-requirements.txt) is the
CLI and its whole dependency closure — the six it names (`pathspec`,
`pydantic`, `rich`, `tree-sitter`, `tree-sitter-language-pack`, `typer`) and
what they pull in — each with the hash of every file PyPI serves for that
version, the native wheels of every platform among them, so one file serves all
three runners and a changed release of any package fails the install.
`pip install codebase-index==2.0.0` names the same CLI without that file and
leaves the dependencies floating; it is not the way to install it. The CLI's own
wheel, `codebase_index-2.0.0-py3-none-any.whl`, hashes to
`sha256:93d49a87957bef85bed7ee64f8c364d188cd4f48e9522161977215b41dc566ac`;
`pip download codebase-index==2.0.0 --no-deps -d <empty dir>` followed by
`pip hash <the wheel>` checks it against PyPI.

**To move the pin**, install the new version in a scratch virtual environment,
run the harness suite and a search through the MCP server, then regenerate the
file there and commit it with the version and the hash above in one commit:

```bash
echo codebase-index==<new> > requirements.in
pip install pip-tools
pip-compile --generate-hashes --strip-extras --output-file=docs/codebase-index-requirements.txt requirements.in
```

`pip-compile` resolves for the host it runs on, so a dependency one platform
alone needs (`colorama`, for Windows) is in the file only if that host reaches
it: regenerate on Windows, which is the superset, and read the diff for a
package that vanished. `CLAUDE.md` cites this section and states neither the
version nor the file.

**The commit gate needs a pull request's number and a base**, and reads git
rather than `gh`, so a branch can run it once its pull request exists
(#207):

```bash
git fetch origin main
py -3.12 .github/commit-gate/commit_gate.py --pr <n> origin/main HEAD
```

Its own suite runs in the workflow that enforces it (`python -m unittest` in
`.github/commit-gate/`); the two helpers it pairs with,
`git-trailer-pr.sh` and `git-revert-pr.sh`, are covered by
`test_git_pr_trailer_helpers.py` in the harness suite. Reverting a pull request
is `bash .claude/scripts/git-revert-pr.sh <n>` from a working branch.

**`npm test` must exit, not watch.** The Angular unit-test builder runs once
and exits here, and `CI=true npm test` is how that is confirmed locally. A
watch-mode test step does not fail a build — it consumes the job's entire
timeout, which is a far more expensive way to find out. Every job in `ci.yml`
sets a `timeout-minutes` for that reason, as headroom over its usual run
rather than a statement of its duration; a new job takes one too.

**`npm test` needs git and a git working tree.**
`src/app/core/lint-coverage.spec.ts` takes the files it judges from
`git ls-files`, so a git-ignored tool directory cannot fail a local run
(#330). An exported tree with no `.git` fails that file rather than passing
it on an empty list.

## What the Playwright suite needs, and why it is CI's

`npm run e2e` is the one suite that cannot run from a bare checkout. It needs:

| | |
|---|---|
| Browsers | `npx playwright install --with-deps chromium webkit`, once; the suite runs in both (below) |
| The dev server on **5173** | Playwright starts it itself (`webServer` in `playwright.config.ts`), and reuses a running one outside CI |
| The backend's gateway on **5000** | `docker compose -f deploy/compose/docker-compose.yml up -d --wait` in the backend checkout |
| Keycloak on **8080** | part of the same stack; the smoke signs in through it |

Those ports are not choices. `src/app/core/config/environment.development.ts`
reads each of them out of the backend's Compose files and says which line, and
a client that needed one changed would be a client the backend has to
accommodate. Do not "fix" a port here.

**This table is the one place they are written down, and everything else
cites it.** `change-locality.md` §2 gives every fact one owner: the owner of
a port *value* is the environment file above, and the owner of *what a local
e2e run needs* is this table. `/ship`, `/review-branch`, `/bug-sweep`,
`npm-checks.sh` and `CLAUDE.md` each name the prerequisite and point here
rather than repeating the number — they used to repeat it, which is how one
port change would have left five stale copies behind.

**Three projects, run one after another.** `playwright.config.ts` defines
`chromium` (desktop, what the suite always was), `webkit` (Desktop Safari: the
engine of the iOS WebView) and `phone` (the Pixel 7 descriptor: Chromium, the
Android WebView's engine, at a phone's viewport with touch). Every spec runs in
every project, and `workers: 1` makes them serial, because the smoke places an
order and publishes products on a stack with no delete endpoint; in parallel
the projects would share one `demo` user's session state. Run one with
`npm run e2e -- --project webkit`. A WebKit run needs the second browser
installed above, and on Linux the system libraries `--with-deps` brings.

**The accessibility walk is `e2e/a11y.spec.ts`**, and it fails on any `serious`
or `critical` axe violation. It signs in as `demo`, which holds `catalog:write`,
and walks every route in the state a person sees it — a published product,
reached from its row and opened cold from its address, and one that is not
available, the cart quoted, the checkout form, the placed order once its
status has settled — in both palettes, because the dark one is the
`.ion-palette-dark` class, which the app sets only when the device is dark
(`colorScheme` in the test makes it so). It asserts the address before each
scan, so a guard's bounce fails the walk instead of being scanned as the page
it was bounced to.
`e2e/a11y-routes.ts` is the list of routes the walk claims;
`src/app/app.routes.spec.ts` fails the unit suite when that list and the
router disagree, which is what stops the gate silently missing the next route
added. Axe cannot see focus management, so the walk asserts it itself (#240):
after each navigation the focused element is the page's `ion-title` (the shell
moves it, `src/app/tabs/focus-page-heading.ts`).

**There is no skip path, and that is the rule rather than an omission.**
`e2e/smoke.spec.ts`'s `beforeAll` asserts the gateway is answering and fails
with a message naming the address when it is not. `retries: 0` for the same
reason: a flaky smoke against a real stack is a fact about the stack, and a
skip on a missing daemon fails open — CI goes green on a runner whose Docker
broke.

**So no command runs it.** `npm-checks.sh` offers no `e2e` mode, `/ship` and
`/review-branch` both say plainly that the suite was not run rather than
implying it was green. CI's `e2e` job is where it runs — on pull requests,
and on pushes to `main`.
**Not on every push**, which this said and which `ci.yml` contradicts in its
own opening comment: the triggers are `push: branches: [main]` and
`pull_request`, deliberately, because an unqualified `push:` ran both jobs
twice for every commit on a PR branch. So a commit pushed to a branch with no
pull request open runs nothing at all, and is verified by nothing.

## The emulator round trip

What a developer runs to put this client on an Android emulator, in order, as
walked on 2026-10-16 (Windows 11, Docker Desktop, an API 36 AVD, the backend's
Compose stack already up). `client-architecture.md` §15 owns *why* each step is
shaped as it is; this section owns the commands and what was seen.

**Prerequisites.** The Android SDK (`platform-tools`, `emulator`, the platform
`android/variables.gradle` compiles against) with `ANDROID_HOME` pointing at it,
and `JAVA_HOME` on a JDK; an AVD whose image carries Google APIs, since sign-in
runs in Chrome; the Compose stack healthy; `npm ci` done here. Nothing here
starts the emulator for you.

**Four reads before the first run.** Each one has been the reason a first
device run failed; the first three change nothing:

1. **An emulator is attached.** `adb devices` lists a line ending `device`
   (`emulator-5554  device`). An empty list, or `offline` or `unauthorized`,
   means nothing will install. `adb` lives in `$ANDROID_HOME/platform-tools`
   and is not on `PATH` by default.
2. **The gateway admits the WebView's origin.** On Android that is
   `https://localhost` — the one origin the packaged build sends, because
   Capacitor's `androidScheme` defaults to `https`. It must be among the
   gateway's `Cors__Origins__*` (`deploy/compose/services/gateway.yml` in the
   backend). `capacitor://localhost` is the iOS origin and is not needed for
   Android. Measured: a request to the gateway with `Origin: https://localhost`
   is answered with `Access-Control-Allow-Origin: https://localhost`.
3. **The realm's `mobile-app` client agrees with the app.** Its redirect URI is
   exactly `blueprint://auth/callback`, which is what `nativeRedirectUri` in
   the three environment files sends, and its `webOrigins` name
   `https://localhost` and `capacitor://localhost`. Keycloak imports the realm
   only into an empty database, so a container that predates the origins serves
   the old values until it is recreated; read the running realm, not the file.
4. **The emulator's `localhost` is the host's for Keycloak's port.**
   `adb reverse tcp:8080 tcp:8080` once per emulator boot (`adb reverse
   --list` shows it, and it is lost when the emulator restarts). Keycloak pins
   its frontend URL to `localhost` (`KC_HOSTNAME` in the backend's
   `infrastructure.yml`; backend `14.1` says why the pin stays), so the
   login form and every redirect name `localhost`, and `environment.android.ts`
   therefore uses `localhost` as the issuer, not the `10.0.2.2` alias the
   gateway uses. Without the reverse, sign-in loads the login page and then
   the browser lands on a refused connection. This one changes the emulator's
   forwarding, not the host.

**The commands, in order.** From the repository root:

```bash
npm run emulator:android           # android build, then cap sync with the emulator flag
```

That writes `server.cleartext` and `android.allowMixedContent` into
`android/app/src/main/assets/capacitor.config.json`; both must be present
afterwards, or every call to the gateway fails (§15, *two blocks, two keys*).
Then install and launch:

```bash
npm run emulator:android:run -- --target emulator-5554
```

`cap run` asks which target to use when an AVD exists as well as an attached
emulator, and the prompt cannot be answered from a script, so pass `--target`
with the serial `adb devices` printed. **This form is for Linux and macOS.**
On a Windows host it fails (`'gradlew' is not recognized as an internal or
external command`): Capacitor invokes `./gradlew`, which `cmd.exe` cannot run
(#192). Use the script that spells the platform's own wrapper instead; it
keeps the flagged sync in place because Gradle does not sync:

```powershell
npm run emulator:android:run:windows
```

It runs `gradlew.bat installDebug` and then `adb shell am start`, neither of
which prompts, so it takes no `--target`: with more than one device attached,
set `ANDROID_SERIAL` to the serial first
(`$env:ANDROID_SERIAL = 'emulator-5554'`), which both Gradle and `adb` honour.
The application id in it is the one in `capacitor.config.ts`; change both
together, because `emulator-launcher.spec.ts` fails the unit suite when they
disagree.

**What to expect.** The Products tab fills from the gateway: that is the
cross-origin read, over cleartext, from `https://localhost`, and it needs no
sign-in. A `Mixed Content` line in `adb logcat` for that request is a console
warning, not a refusal.

**A hand on the device is needed.** Two steps, both in the system browser:

- *Chrome's first-run screen.* A freshly booted AVD opens "Make Chrome your
  own" when Sign in is first tapped; choose "Use without an account". Manual.
- *Typing the credentials.* `demo` / `demo`, by hand or with `adb shell input
  text`. Manual.

**Sign-in, then.** Observed on 2026-10-16: with the reverse in place and the
credentials accepted, the custom tab closes, the return lands in the running
app (not a second copy), and Account shows `demo` with its five permissions
and "Refresh token in secure storage". Force-stopping the app and starting it
again keeps the session. Not observed: browsing to an order and cancelling it
(§15 step 4), the sign-in-sign-out-sign-in race (step 3's second half), and
that the cart survives a relaunch.

**The order stream, from the WebView (#243).** `e2e/native-stream.mts` reads
`GET /bff/v1/orders/{id}/events` from inside the running app's WebView and
prints when each chunk arrived; its header says what it does and does not
answer. It needs no sign-in, because it takes the `demo` user's token by the
realm's direct grant on the host, and it reaches the WebView through its
DevTools socket, which a debug build exposes:

```bash
adb shell cat /proc/net/unix | grep -o 'webview_devtools_remote_[0-9]*'
adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
node e2e/native-stream.mts           # places an order; or pass an order id
```

The pid changes on every launch, so the forward is redone each time. Node
warns that `environment.android.ts` was reparsed as an ES module; that is its
module detection and not a failure.

Measured on 2026-10-18, on the API 36 AVD with Android System WebView
`133.0.6943.137`, from origin `https://localhost`, over `fetch` read as
`FetchBackend` reads it: the `placed` event arrived 13 ms after the request,
the `out_of_stock` that followed it at 2,012 ms — the server's two-second
poll — and a keep-alive at 12,022 ms, each from a body read that resolved
while the response was still open, and the server ended the stream at
14,024 ms. So the WebView delivers the stream as it is written and does not
hold it until the end. The second request, carrying the first's last id as
`Last-Event-ID`, passed its preflight and was answered with the `retry:` hint
and a keep-alive and no event, so nothing the client held was sent again.
Not observed: the same through the app's own `OrderPlacedPage`, which needs
the signed-in round trip above; the client reopening the stream on its own
when the server's lifetime ends, which the script does by hand instead; the
close on `delivered`, which an order for an out-of-stock product never reaches;
and anything on iOS, which no host here can run.

## What no unit test covers

State this in a PR body rather than letting a green suite imply it:

- **The emulator relaxations.** `capacitor.config.ts` gates cleartext traffic
  and mixed content, and both keys leave the TypeScript and land in files
  `cap sync` generates. Lint, the unit suite and the web build see none of it.
  CI's `android` job asserts them in **both** directions — that the documented
  command enables them, and that a release sync does not — and it is the only
  check that does.
- **The iOS project, on a device.** `ios-config` runs `npx cap sync ios`,
  which does not compile Swift; `ios-build` does, as an unsigned simulator
  build on a pinned macOS runner. Neither launches the app, so the project is
  compiled and unproven on a simulator or a device.
- **Anything behind sign-in, end to end.** The unit suite fakes the token. The
  smoke is the only place a real Keycloak round trip happens.

## The setup file

`src/vitest-setup.ts` is not boilerplate and its comment is worth reading
before editing it. It registers Ionic's custom elements once — without which a
page test renders an empty `<ion-content>` and asserts nothing — and it
eagerly imports `@ionic/core` to put the gesture-controller chunk in the
module registry before any test runs. That second import is the fix for an
`EnvironmentTeardownError` that turned a wholly passing run into exit 1 in CI
and reproduced nowhere locally. It is a load-bearing import with no
binding; a linter that offers to remove it is wrong.
