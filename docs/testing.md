# Testing

What a checkout needs that `package.json` and `.github/workflows/ci.yml`
cannot say.

**This file restates neither.** `package.json` is the list of invocations and
`ci.yml` is the list of jobs; [`client-architecture.md`](client-architecture.md)
§14 owns **what CI runs, and which smoke tests are left failing on the
development machine and why** — read it before concluding a red smoke is a
defect.
What follows is the rest: the prerequisites, the wrapper, and the three things
that have actually cost time here.

## The invocations

```bash
npm ci                      # from the lockfile, always — never `npm install`
npm run lint                # ESLint over src/**/*.ts and src/**/*.html
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

**A new worktree has no `node_modules`.** It is gitignored, so `/branch`'s
sibling worktree carries the lockfile and none of what it pins. The first
check in it fails on a missing `ng` binary, which reads like a broken
toolchain rather than an uninstalled one. Run `npm ci` once after moving in.

**`npm test` must exit, not watch.** The Angular unit-test builder runs once
and exits here, and `CI=true npm test` is how that is confirmed locally. A
watch-mode test step does not fail a build — it consumes the job's entire
timeout, which is a far more expensive way to find out.

## What the Playwright suite needs, and why it is CI's

`npm run e2e` is the one suite that cannot run from a bare checkout. It needs:

| | |
|---|---|
| A browser | `npx playwright install --with-deps chromium`, once |
| The dev server on **5173** | Playwright starts it itself (`webServer` in `playwright.config.ts`), and reuses a running one outside CI |
| The backend's gateway on **5000** | `docker compose -f deploy/compose/docker-compose.yml up -d --wait` in the backend checkout |
| Keycloak on **8080** | part of the same stack; the smoke signs in through it |

Those ports are not choices. `src/app/core/config/environment.development.ts`
reads each of them out of the backend's Compose files and says which line, and
a client that needed one changed would be a client the backend has to
accommodate. Do not "fix" a port here.

**There is no skip path, and that is the rule rather than an omission.**
`e2e/smoke.spec.ts`'s `beforeAll` asserts the gateway is answering and fails
with a message naming the address when it is not. `retries: 0` for the same
reason: a flaky smoke against a real stack is a fact about the stack, and a
skip on a missing daemon fails open — CI goes green on a runner whose Docker
broke.

**So no command runs it.** `npm-checks.sh` offers no `e2e` mode, `/ship` and
`/review-branch` both say plainly that the suite was not run rather than
implying it was green, and the external reviewer's sandbox has no Node at all.
CI's `e2e` job is where it runs on every push.

## What no unit test covers

State this in a PR body rather than letting a green suite imply it:

- **The emulator relaxations.** `capacitor.config.ts` gates cleartext traffic
  and mixed content, and both keys leave the TypeScript and land in files
  `cap sync` generates. Lint, the unit suite and the web build see none of it.
  CI's `android` job asserts them in **both** directions — that the documented
  command enables them, and that a release sync does not — and it is the only
  check that does.
- **The iOS project.** `ios-config` runs `npx cap sync ios`, which does not
  compile Swift. It catches a missing plugin or a config that stopped parsing
  and nothing else; the compile job exists and is commented out.
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
