# The game day

A failure response nobody has caused is a claim. This directory **causes** a
failure the web build documents a response to, on the backend's Compose stack,
checks in a real browser that the app answers it as its code says it will,
restores the stack, and checks that the app comes back with it. #628 is the
specification; this README owns what a run does and what a pass proves.

```bash
node e2e/game-day/game-day.mts --list            # the scenarios, and what none causes
node e2e/game-day/game-day.mts gateway-down      # one scenario
node e2e/game-day/game-day.mts --matrix all      # CI's plan, as a GITHUB_OUTPUT line
node --test e2e/game-day/harness-suite.mts       # the suite; needs no stack and no browser
```

A run needs what `docs/testing.md` *What the Playwright suite needs* lists, but
for one thing: Playwright's `webServer` does not start the dev server here, so
`npm start` runs first. It also needs `GAME_DAY_COMPOSE`, the path of the
backend's `deploy/compose/docker-compose.yml`, unless the backend is checked
out beside this repository's root, and the Chromium that `npx playwright
install chromium` puts in place. `GAME_DAY_APP` points at a dev server
elsewhere than 5173.

Exit 0 means the services the cause touches were running and the gateway was
ready before the cause, the app answered within the
scenario's deadline, the stack settled after the restore, and the app came back
by the way back it offers. Anything else prints a `FINDING:` line on stderr, and
**a finding is the product**: each one is a defect in the app, in its document
or in this scenario, and gets its own issue. The run ends on one line,
`game day: offline OK in 0m12s` or `game day: offline FAILED in 1m40s`. Exit 2
is a refusal: no such scenario, arguments that do not parse, or a browser that
does not start, since a run that never reached the app is no finding about it.

## The shape, and why it is the backend's

The backend's `tools/game-day/` causes a runbook's alert; the frontend has no
alerts, so what it causes is a failure a user meets and what it checks is the
screen. The shape is the backend's all the same: a quiet start, the cause, a
check polled to a deadline, a restore that runs whatever happened before it,
and a settle. It adds one step, **recovered**: the stack coming back is not the
app coming back, and a screen that needs a reload to recover is a finding.

It is TypeScript under `e2e/` rather than stdlib Python, because the check is a
browser's and Playwright is this repository's own test stack, and because
`npm run lint` type-checks and lints everything under `e2e/`. It is not a
Playwright spec: `npm run e2e` runs every spec against a healthy stack, and a
scenario that stops the gateway would break the smoke running beside it. So no
file here matches Playwright's `testMatch`, and the runner drives Chromium
through the library, as `e2e/native-stream.mts` drives a WebView. Node prints a
`MODULE_TYPELESS_PACKAGE_JSON` warning on start, because the root
`package.json` declares no module type; it says nothing about the run.

| File | Owns |
|---|---|
| `harness.ts` | Compose control (`stop`, `start`, `pause`, `unpause`, `state`), `waitUntil`, `probe`, the `World` and the `Scenario` contract |
| `scenarios.ts` | The scenarios, and `NOT_CAUSED`: each failure #628 asks after that none causes, with why |
| `runner.ts` | The order, the quiet start, `--matrix` and the verdict line |
| `game-day.mts` | The command line, and the browser |
| `harness-suite.mts` | The suite, run by `.github/workflows/game-day.yml` on a pull request that touches a path its `paths` filter names |

## A scenario

Every scenario names its `promise`, a sentence, and its `source`, the
`file:line` that makes it; the suite fails a `source` that points at a blank
line or past the end. `services` are the Compose services its cause touches,
each of which must be `running` before the cause, or nothing is caused.

`restore` finds what to undo in the stack and not in the process: a paused
container refuses `start` and a running one refuses `unpause`, so it reads the
container's state first. It is safe to run twice and safe when the cause never
ran, and the runner calls it whatever the cause did, a cause that threw
half-way included.

| Scenario | Cause | The app is to | Way back |
|---|---|---|---|
| `gateway-down` | `stop gateway`, then reload the product list | show the `retry` banner: no response is status 0 | *Try again* loads the list |
| `catalog-down` | `stop catalog-api`, then reload | show a banner for the gateway's 5xx: `unavailable` for a 503, `retry` for any other | *Try again* loads the list |
| `catalog-slow` | `pause catalog-api`, then reload | show the `retry` banner for the gateway's 504 at its route deadline, rather than hang | *Try again* loads the list |
| `keycloak-down` | `stop keycloak`, then open the Account tab and press *Sign in* | stay in the app and show an error banner, rather than a button that does nothing | *Sign in* reaches Keycloak |
| `offline` | the browser context goes offline | show the offline banner, and the stale line over a list that holds rows | both go when it is online again |

`catalog-down` accepts either banner because which 5xx the gateway answers for
a stopped service is the gateway's to choose, and the client's promise covers
both. `offline` asks for the stale line only over rows, because that is when
`products.page.ts` promises it and a fresh stack's catalogue is empty.

## What it does not cause

A 401 in the middle of a session. The web realm issues no refresh token and
holds the access token in memory (spec §5.6), so an expired session is the
token's lifespan running out, and shortening it is a realm setting the backend
owns; a revoked one reaches the client only if the gateway checks the session
rather than the token. `--list` prints both reasons, and `NOT_CAUSED` is where
they live.

## Running it in CI

`.github/workflows/game-day.yml` runs the suite on a pull request or a push to
`main` that touches this directory, `e2e/helpers.ts`, `src/` for the lines the
scenarios cite, `.nvmrc` or the lockfile, and the scenarios on
`workflow_dispatch` only, one job and one stack per scenario, as the backend's
does: a scenario
that dies cannot poison the next, and a stack started for each is the price of
that. The dispatch starts the stack as the `e2e` job in `ci.yml` does, then
the dev server, then the scenario.
