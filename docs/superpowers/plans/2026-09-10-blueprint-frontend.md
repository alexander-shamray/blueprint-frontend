# Blueprint Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the reference client for `dotnet-ddd-blueprint` — one Angular codebase running as web, Android and iOS, exercising every endpoint the gateway exposes.

**Architecture:** A standalone Angular 22 application with Ionic 9 components and Capacitor 8 native shells. Three layers with enforced boundaries: `core/api` owns HTTP and the wire types; `core/auth` owns tokens and claims behind one interface with a web and a native implementation; `features/*` own one page each and import only core. A signals cart store lives in core because two features share it. Errors become display models in exactly one place. Nothing about the backend's vocabulary — error text, permission names, reason codes, DTO shapes — is restated in the client's own words; every wire type carries a comment citing the backend file and symbol it mirrors.

**Tech Stack:** Angular 22.1, Ionic 9.0, Capacitor 8.5, TypeScript, Vitest (via `@angular/build:unit-test`), Playwright, `angular-oauth2-oidc` 22, `@aparajita/capacitor-secure-storage` 8.

**Spec:** `docs/superpowers/specs/2026-09-10-blueprint-frontend-design.md` — read it alongside this plan. Every task argues from a numbered section of it.

---

## Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from the spec or verified against the backend at `../blueprint-backend`.

- **Node** 22.22 or newer, pinned in `.nvmrc`. Verified present on the workstation: v22.23.2.
- **Dev server port is 5173, not Angular's default 4200.** The backend's `deploy/compose/services/gateway.yml:32` sets `Cors__Origins__0: "http://localhost:5173"` and the realm's `web-app` client lists `http://localhost:5173` in `webOrigins`. A client must not require the backend to change for it to run.
- **Gateway base URL in development is `http://localhost:5000`** (`gateway.yml:34` publishes `127.0.0.1:5000:8080`). It is the only host the client calls for platform data.
- **Keycloak authority in development is `http://localhost:8080/realms/commerce`** (`infrastructure.yml` sets `KC_HOSTNAME: http://localhost:8080` and publishes `127.0.0.1:8080:8080`; realm name is `commerce`).
- **Exact version pins in `package.json`** — no `^`, no `~`:

  | Package | Version |
  |---|---|
  | `@angular/core`, `@angular/common`, `@angular/forms`, `@angular/router`, `@angular/platform-browser` | `22.1.6` |
  | `@angular/cli`, `@angular/build` | `22.1.8` |
  | `@angular/compiler-cli` | `22.1.6` — tracks `@angular/core`, NOT the CLI. There is no 22.1.7 or 22.1.8; 22.1.6 is the last 22.1.x published. Verified against the registry 2026-09-11. |
  | `@ionic/angular` | `9.0.3` |
  | `@capacitor/core`, `@capacitor/cli`, `@capacitor/android`, `@capacitor/ios` | `8.5.1` |
  | `@capacitor/browser` | `8.0.4` |
  | `@capacitor/app` | `8.1.1` |
  | `@capacitor/preferences` | `8.0.1` |
  | `@aparajita/capacitor-secure-storage` | `8.0.0` |
  | `angular-oauth2-oidc` | `22.0.2` |
  | `vitest` | `4.1.11` — **not 5.x.** `@angular/build@22.1.8` peers `vitest ^4.0.8`, so the published 5.0.0 is incompatible with the builder. Every task writing test code targets Vitest **4**. Verified against the registry 2026-09-11. |
  | `@playwright/test` | `1.63.0` |

- **Ionic 9 imports come from `@ionic/angular`, NOT `@ionic/angular/standalone`.** That subpath does not exist in `@ionic/angular@9.0.3` — its `exports` map has no `./standalone` entry, because the package root itself now resolves to `./dist/standalone/index.js`. The `/standalone` convention was Ionic 7-8. The root re-exports `provideIonicAngular`, `IonTabs`, `IonBackButton` and, via `export * from './directives/proxies'`, every other `Ion*` component these tasks use. Importing the old path fails `TS2307` and cascades into `NG1010`.
- **A dependency is installed by the task that first imports it**, with `npm install --save-exact` so no `^` or `~` reaches `package.json`. `angular-oauth2-oidc` arrives in Task 5; `@capacitor/core` and `@capacitor/preferences` in Task 7, because the cart persists on the web too; the remaining Capacitor packages in Tasks 18 and 21. The scaffold in Task 1 installs none of them.
- **Every `ion-icon` name must be registered with `addIcons`**, once, at module scope in `src/main.ts`. `@ionic/angular`'s exports map resolves to the standalone build, where icons are tree-shaken and there is NO lazy network fetch to fall back on — an unregistered name renders nothing, deterministically, on every platform, and produces no build error. Object shorthand IS correct — `addIcons` registers each key AND a kebab-case conversion of it (`utils.js:29-32`), so `addIcons({ gridOutline })` serves `name="grid-outline"` as well as `name="gridOutline"`. A task adding a new icon adds its constant there.
- **`.gitattributes` is `* text=auto eol=lf`** — already committed, do not change.
- **Citation rule (spec §1, property 2).** Every interface in `core/api/types.ts` and every constant mirroring a backend vocabulary carries a one-line comment naming the backend file and symbol. No error text, permission name, reason code or DTO field name is authored on the client. The only client-authored strings are the six generic banners named in spec §6.
- **A feature never imports another feature.** Enforced by ESLint `no-restricted-imports`, not by convention (Task 1).
- **Test users** (from `deploy/compose/keycloak/realm-export.json`): `demo` / `demo` holds `catalog:write`, `orders:write`, `orders:cancel`; `browser` / `browser` holds none.

---

## Backend Facts — Verified Corrections to the Spec

The spec was written ahead of a read of the backend source. Four statements in it do not match the code. These corrections are authoritative for this plan; where the plan and the spec disagree, the plan is right and `docs/client-architecture.md` (Task 17) records why.

**1. Both POSTs reply `200 OK`, not `201`.** `ProductEndpoints.cs:42` and `OrderEndpoints.cs:45` both `return result.ToHttpResult()`. `ResultExtensions.cs:30` maps a successful `Result<TValue>` to `Results.Ok(result.Value)`. The body is the bare GUID, JSON-encoded as a quoted string (`"3fa85f64-5717-4562-b3fc-2c963f66afa6"`). There is no `Location` header. Spec §2's "`201` with the product id" and "`201` with the order id" are wrong on the status; the id part is right.

**2. `ToHttpResult` can only produce 200, 204, 404, 422 and 503.** `Error.cs:35` is `enum ErrorType { NotFound, Rule, Unavailable }` and `ResultExtensions.StatusFor` throws on anything else. Every other status the client sees comes from middleware, not from a handler.

**3. There are three distinct 409s, told apart by a `code` extension in the problem body — not one.** Spec §6 collapses them into a single `alreadyCommitted` kind, but the three carry *contradicting* instructions, and the backend's own handler comments say a client must switch on `code` rather than on prose:

  | `code` | Producer | Backend's instruction |
  |---|---|---|
  | `request.in_progress` | `ConcurrentRequestExceptionHandler.cs:63` | "A request with this command identifier is already in progress. Retry." |
  | `command.already_committed` | `CommandAlreadyCommittedExceptionHandler.cs:82` | Applied already, result no longer available; **do not** retry |
  | `request.concurrency_conflict` | `ConcurrencyExceptionHandler.cs:65` | "The resource was modified by another request. Re-read it and retry." |

  A plain retry of a command whose id is *still* in the idempotency store is not a 409 at all — `IdempotencyBehavior.cs:137` replays the stored result, so the client sees the original `200` with the same GUID. That is spec §2.1's promise, working.

**4. `Retry-After` and `X-Correlation-Id` are not readable from browser JavaScript.** Neither is a CORS-safelisted response header, and the gateway's policy (`Gateway.Api/Program.cs:332`) is `.WithOrigins(origins).AllowAnyHeader().AllowAnyMethod().AllowCredentials()` with no `WithExposedHeaders`. The correlation id is recoverable anyway: `ProblemDetailsExtensions.cs:57` puts `correlationId` and `traceId` into the problem **body** as extensions, on every error including the 429 (`Program.cs:148`'s `OnRejected` writes through `IProblemDetailsService` precisely so that it matches the shape). The client therefore reads `correlationId` from the body and never from the header. `Retry-After` has no body equivalent and needs the backend change in Task 0.

**Also confirmed accurate in the spec, no change needed:** `accessTokenLifespan` is 300; `web-app` is public with `pkce.code.challenge.method: S256` and `use.refresh.tokens: "false"`; the `permission` claim is a multivalued String mapped from `commerce-api` client roles; `GET /v1/catalog/products` takes `cursor` and `limit` (default 20) and is `AllowAnonymous`; `POST /v1/orders/{id:guid}/cancel` takes `{ "reason": "..." }` and replies 204; an unknown reason is a `Results.ValidationProblem` keyed `Reason`.

---

## Wire Reference

The exact shapes every task codes against. Field casing is what ASP.NET Core's default `JsonSerializerOptions` produces: camelCase.

```
GET  {gateway}/api/v1/catalog/products?cursor={string}&limit={int}
     anonymous · 200
     { "items": [ { "productId": guid, "name": string, "thumbnailUrl": string|null,
                    "amount": number, "currency": string, "publishedAt": string } ],
       "nextCursor": string|null }

POST {gateway}/api/v1/catalog/products          ← needs Task 0's gateway route
     catalog:write · 200 · body is the new product's GUID as a JSON string
     { "commandId": guid, "name": string, "thumbnailUrl": string|null,
       "amount": number, "currency": string }

GET  {gateway}/bff/v1/checkout/quote?productId={guid}&productId={guid}&currency={string}
     authenticated · 200
     { "currency": string, "lines": [ { "productId": guid, "name": string, "amount": number } ],
       "total": number, "unpriced": [ guid ] }

POST {gateway}/api/v1/orders
     orders:write · 200 · body is the new order's GUID as a JSON string
     { "commandId": guid,
       "items": [ { "productId": guid, "quantity": int } ],
       "shippingAddress": { "line1": string, "line2": string|null, "city": string,
                            "postalCode": string, "country": string },
       "currency": string }

POST {gateway}/api/v1/orders/{id}/cancel
     orders:cancel · 204
     { "reason": "out_of_stock"|"stock_timeout"|"payment_declined"|"payment_timeout"|"customer_request" }

Every error, every status: application/problem+json
     { "type": string, "title": string, "status": int, "detail": string?,
       "code": string?, "correlationId": string, "traceId": string,
       "errors": { "<field>": [ string ] }?   ← 400 only
     }
```

---

## File Structure

Files that change together live together. Each file has one responsibility and is small enough to hold in view at once.

| File | Responsibility | Task |
|---|---|---|
| `.nvmrc`, `package.json`, `angular.json`, `eslint.config.js`, `tsconfig.json` | Toolchain, exact pins, port 5173, import boundaries | 1 |
| `src/app/core/config/environment.model.ts` | The `Environment` interface, and its ONLY export site | 2 |
| `src/app/core/config/environment.ts` | Production values | 2 |
| `src/app/core/config/environment.development.ts` | Development values: gateway 5000, Keycloak 8080. Replaces `environment.ts` wholesale under `fileReplacements` | 2 |
| `src/app/core/api/types.ts` | Every wire type, one per backend record, each citing its owner | 3 |
| `src/app/core/errors/problem-details.ts` | The RFC 9457 body shape plus the backend's extensions | 4 |
| `src/app/core/errors/error-mapper.ts` | The only place an `HttpErrorResponse` becomes a display model | 4 |
| `src/app/core/auth/auth.service.ts` | The `AuthService` interface and its injection token | 5 |
| `src/app/core/auth/current-user.ts` | Access-token claims as a signal | 5 |
| `src/app/core/auth/web-auth.strategy.ts` | PKCE code flow, in-memory tokens, silent renewal | 5 |
| `src/app/core/auth/auth.interceptor.ts` | Bearer header on gateway URLs and nothing else | 5 |
| `src/app/core/auth/permission.guard.ts` | Route guard reading `hasPermission`, carrying the needed name | 5 |
| `src/app/core/auth/auth.providers.ts` | The platform factory: web or native strategy | 5, 19 |
| `src/app/core/api/catalog.api.ts` | `GET`/`POST` products | 6 |
| `src/app/core/api/checkout.api.ts` | `GET` quote | 6 |
| `src/app/core/api/ordering.api.ts` | `POST` order, `POST` cancel | 6 |
| `src/app/core/cart/cart.store.ts` | Signals store of cart lines | 7 |
| `src/app/core/cart/cart.persistence.ts` | Capacitor Preferences read/write | 7 |
| `src/app/core/commands/command-id.ts` | The command-id lifecycle state machine | 8 |
| `src/app/app.routes.ts`, `src/app/app.ts`, `src/app/tabs/*` | Shell, tabs, routing, permission-gated fourth tab | 9 |
| `src/app/features/products/products.page.ts` | Spec §5.1 | 10 |
| `src/app/features/cart/cart.page.ts` | Spec §5.2 | 11 |
| `src/app/features/checkout/checkout.page.ts` | Spec §5.3 | 12 |
| `src/app/features/order-placed/order-placed.page.ts` | Spec §5.4 | 13 |
| `src/app/features/publish/publish.page.ts` | Spec §5.5 | 14 |
| `src/app/features/account/account.page.ts` | Spec §5.6 | 15 |
| `src/app/shared/error-banner.component.ts` | Renders one display model; the six generic strings live here | 4 |
| `e2e/smoke.spec.ts` | Playwright smoke against the Compose stack | 16 |
| `.github/workflows/ci.yml` | Lint, test, build, Android, iOS check, e2e | 17, 21 |
| `docs/client-architecture.md` | Each backend decision, and where it shows up here | 17 |
| `src/app/core/auth/native-auth.strategy.ts` | System-browser PKCE, secure storage, rotation | 19 |

---

## Phase Structure

**Phase A (Tasks 0–17) delivers a complete, working web client.** Stopping after Task 17 leaves shipped software: all six screens, every endpoint, the error table, unit and component tests, an e2e smoke and CI.

**Phase B (Tasks 18–21) adds Android and iOS.** It depends on Task 0's `mobile-app` Keycloak client.

---

## Task 0: Backend dependency PR

This is one pull request against `../blueprint-backend`, not against this repository. It is listed first because Task 14 (Publish) and Phase B are blocked on it, and because the spec's §9 already establishes the pattern: a client may be built against a backend change that has not merged, and its tests name what the change introduces.

**Everything else in Phase A is unblocked by it.** Tasks 1–13 and 15–17 can be completed and merged before this PR lands.

**Files (in `../blueprint-backend`):**
- Modify: `src/Gateway/Gateway.Api/appsettings.json` — add a `catalog-write` route
- Modify: `src/Gateway/Gateway.Api/Program.cs:332-337` — add `WithExposedHeaders`
- Modify: `deploy/compose/keycloak/realm-export.json` — add the `mobile-app` client, set realm rotation
- Modify: `deploy/keycloak/realm_check.py` — assert the second client
- Test: the gateway's existing route config tests (the "every policy resolves" and "every strip matches" pair named in `appsettings.json`'s header comment)

**Interfaces:**
- Produces: a gateway route admitting `POST /api/v1/catalog/products`; `Access-Control-Expose-Headers: Retry-After` on gateway responses; a Keycloak public client `mobile-app` with redirect URI `blueprint://auth/callback` and `use.refresh.tokens: "true"`.

- [ ] **Step 1: Add the `catalog-write` route**

In `src/Gateway/Gateway.Api/appsettings.json`, inside `ReverseProxy.Routes`, after `catalog-public`:

```json
      // Catalog's write side, which catalog-public deliberately does not
      // match: that route names GET alone so a public listing cannot become a
      // public publish by widening one line. A separate route rather than a
      // method added to that one, because the two differ in every field that
      // matters — policy, limiter, and the reason each exists. The endpoint
      // itself still requires catalog:write (CatalogPermissions.Write); this
      // route's "authenticated" is the edge's coarser question, and the two
      // are not redundant for the reason §11.2 gives.
      "catalog-write": {
        "ClusterId": "catalog",
        "Match": { "Path": "/api/v1/catalog/{**catch-all}", "Methods": [ "POST" ] },
        "AuthorizationPolicy": "authenticated",
        "RateLimiterPolicy": "authenticated",
        "Transforms": [
          { "PathRemovePrefix": "/api" },
          { "RequestHeader": "X-Forwarded-Prefix", "Set": "/api" }
        ]
      },
```

- [ ] **Step 2: Expose `Retry-After` to browsers**

In `src/Gateway/Gateway.Api/Program.cs`, in the `AddCors` callback:

```csharp
    builder.Services
        .AddCors(o =>
            o.AddDefaultPolicy(p => p
                .WithOrigins(origins)
                .AllowAnyHeader()
                .AllowAnyMethod()
                // Retry-After is not a CORS-safelisted response header, so
                // without this line a browser client cannot read the value
                // §10.3's rejection handler goes to the trouble of computing —
                // it reaches the network and is dropped before script sees it.
                // The correlation id needs no entry here: it rides in the
                // problem body as an extension member, which is readable
                // whatever the header policy says.
                .WithExposedHeaders("Retry-After")
                .AllowCredentials()));
```

- [ ] **Step 3: Add the `mobile-app` client to the realm export**

In `deploy/compose/keycloak/realm-export.json`, add to `clients`:

```json
    {
      "clientId": "mobile-app",
      "enabled": true,
      "publicClient": true,
      "standardFlowEnabled": true,
      "directAccessGrantsEnabled": false,
      "implicitFlowEnabled": false,
      "serviceAccountsEnabled": false,
      "redirectUris": [ "blueprint://auth/callback" ],
      "webOrigins": [],
      "defaultClientScopes": [ "web-origins", "acr", "profile", "roles", "basic", "commerce-api", "email" ],
      "attributes": {
        "realm_client": "false",
        "pkce.code.challenge.method": "S256",
        "use.refresh.tokens": "true"
      }
    },
```

And at the realm level, set rotation:

```json
  "revokeRefreshToken": true,
  "refreshTokenMaxReuse": 0,
```

`refreshTokenMaxReuse` is already `0`; `revokeRefreshToken` is currently `false` and becomes `true`. It is a realm setting and applies to every client, which is acceptable because `web-app` receives no refresh token to rotate.

- [ ] **Step 4: Teach `realm_check.py` the second client**

Give `mobile-app` the same test shape `web-app` has, asserting: `publicClient`, `standardFlowEnabled`, `pkce.code.challenge.method == "S256"`, `use.refresh.tokens == "true"`, `redirectUris == ["blueprint://auth/callback"]`, `directAccessGrantsEnabled` false, `implicitFlowEnabled` false, and `commerce-api` among `defaultClientScopes`. Add a realm-level assertion that `revokeRefreshToken` is true and `refreshTokenMaxReuse` is 0.

- [ ] **Step 5: Run the backend's gateway route tests**

Run: `dotnet test --filter "FullyQualifiedName~Gateway"` from the backend root.
Expected: PASS. The "every policy resolves" and "every strip matches" tests now cover five routes instead of four.

- [ ] **Step 6: Verify the route end-to-end**

Run, from the backend root:

```bash
docker compose -f deploy/compose/docker-compose.yml up -d --wait
TOKEN=$(curl -s -X POST http://localhost:8080/realms/commerce/protocol/openid-connect/token \
  -d client_id=web-app -d grant_type=password -d username=demo -d password=demo \
  | python -c "import sys,json;print(json.load(sys.stdin)['access_token'])")
curl -i -X POST http://localhost:5000/api/v1/catalog/products \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"commandId":"11111111-1111-1111-1111-111111111111","name":"Route check","amount":9.99,"currency":"EUR"}'
```

Expected: `HTTP/1.1 200 OK` with a quoted GUID body. Before this task it was `404`.

- [ ] **Step 7: Commit and open the PR**

```bash
git add src/Gateway/Gateway.Api/appsettings.json src/Gateway/Gateway.Api/Program.cs \
        deploy/compose/keycloak/realm-export.json deploy/keycloak/realm_check.py
git commit -m "feat(gateway): route catalog writes, expose Retry-After, add mobile-app client"
```

---
## Task 1: Scaffold, toolchain and import boundaries

**Files:**
- Create: `.nvmrc`, `package.json`, `angular.json`, `tsconfig.json`, `eslint.config.js`, `vitest-setup.ts`, `src/` tree
- Create: `src/app/core/boundaries.spec.ts`

**Interfaces:**
- Produces: `npm run start` on port 5173, `npm test`, `npm run lint`, `npm run build`. The `@core/*` and `@features/*` path aliases every later task imports through.

- [ ] **Step 1: Generate the Angular application**

The spec §3 says "generated by the Ionic CLI". Use `ng new` plus Ionic's own `ng add` schematic instead: `@ionic/cli` was last published 2025-03-18 and its starter templates predate Angular 22, while `@ionic/angular@9.0.3` peers `@angular/core >=18.0.0` and ships an `ng add` collection. Same standalone application, current Angular. Record the deviation in `docs/client-architecture.md` (Task 17).

Run from the repository's parent so the tool does not nest a folder:

```bash
npx --yes @angular/cli@22.1.8 new blueprint-frontend \
  --directory . --style=css --routing=true --ssr=false --skip-git --package-manager=npm
npx ng add @ionic/angular@9.0.3 --skip-confirmation
```

- [ ] **Step 2: Pin every version exactly**

Rewrite `dependencies` and `devDependencies` in `package.json` with the exact strings from Global Constraints — no `^`, no `~`. Then:

```bash
rm -rf node_modules package-lock.json && npm install
node -e "const p=require('./package.json');const bad=Object.entries({...p.dependencies,...p.devDependencies}).filter(([,v])=>/^[\^~]/.test(v));if(bad.length){console.error('unpinned:',bad);process.exit(1)}console.log('all pinned')"
```

Expected: `all pinned`.

- [ ] **Step 3: Write `.nvmrc`**

```
22.22.0
```

- [ ] **Step 4: Move the dev server to 5173**

In `angular.json`, under `projects.blueprint-frontend.architect.serve.options`:

```json
"port": 5173,
"host": "localhost"
```

- [ ] **Step 5: Add the path aliases**

In `tsconfig.json` under `compilerOptions`:

```json
"baseUrl": "./src",
"paths": {
  "@core/*": ["app/core/*"],
  "@features/*": ["app/features/*"],
  "@shared/*": ["app/shared/*"]
}
```

- [ ] **Step 6: Configure the Vitest builder**

In `angular.json`, replace the `test` target:

```json
"test": {
  "builder": "@angular/build:unit-test",
  "options": {
    "tsConfig": "tsconfig.spec.json",
    "setupFiles": ["src/vitest-setup.ts"],
    "include": ["src/**/*.spec.ts"],
    "coverage": { "enabled": false }
  }
}
```

Create `src/vitest-setup.ts`:

```ts
// Ionic's web components are custom elements; registering them once here keeps
// every component test from doing it, and keeps a page test from silently
// rendering an empty <ion-content> that asserts nothing.
import { defineCustomElements } from '@ionic/core/loader';

defineCustomElements(window);
```

- [ ] **Step 7: Write the failing boundary test**

`src/app/core/boundaries.spec.ts`:

```ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Spec §3: "A feature never imports another feature." The ESLint rule is the
 * enforcement; this test is the proof that the rule is wired to something,
 * because a misconfigured no-restricted-imports passes silently and a rule
 * nobody checks is a comment.
 */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });
}

describe('import boundaries', () => {
  const featuresRoot = join(process.cwd(), 'src', 'app', 'features');

  it('no feature imports another feature', () => {
    const offenders: string[] = [];

    for (const file of walk(featuresRoot)) {
      const owner = file.slice(featuresRoot.length + 1).split(/[\\/]/)[0];
      const source = readFileSync(file, 'utf8');

      for (const match of source.matchAll(/from\s+['"]@features\/([^/'"]+)/g)) {
        if (match[1] !== owner) offenders.push(`${file} imports @features/${match[1]}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('core imports no feature', () => {
    const coreRoot = join(process.cwd(), 'src', 'app', 'core');
    const offenders = walk(coreRoot).filter((file) =>
      /from\s+['"]@features\//.test(readFileSync(file, 'utf8')),
    );

    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 8: Run it and watch it fail**

Run: `npm test`
Expected: FAIL — `ENOENT: no such file or directory` on `src/app/features`, because no feature exists yet.

- [ ] **Step 9: Create the empty feature folders and make it pass**

```bash
mkdir -p src/app/features/products src/app/features/cart src/app/features/checkout \
         src/app/features/order-placed src/app/features/publish src/app/features/account \
         src/app/core/api src/app/core/auth src/app/core/cart src/app/core/commands \
         src/app/core/config src/app/core/errors src/app/shared
```

Run: `npm test`
Expected: PASS, 2 tests.

- [ ] **Step 10: Add the ESLint boundary rule**

In `eslint.config.js`, add a config block:

```js
  {
    files: ['src/app/features/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['@features/*/*', '../*/'],
          message:
            'A feature never imports another feature (spec §3). Shared state belongs in core — that is why the cart store lives there.',
        }],
      }],
    },
  },
  {
    files: ['src/app/core/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['@features/*'],
          message: 'core knows nothing about screens (spec §3).',
        }],
      }],
    },
  },
```

- [ ] **Step 11: Verify lint, build and the port**

```bash
npm run lint && npm run build
```

Expected: both pass. Then `npm start` and confirm the banner reads `http://localhost:5173/`; stop it.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "chore: scaffold Angular 22 + Ionic 9 app with pinned versions and import boundaries"
```

---

## Task 2: Configuration

**Files:**
- Create: `src/app/core/config/environment.model.ts` — the `Environment` interface
- Create: `src/app/core/config/environment.ts` — production values
- Create: `src/app/core/config/environment.development.ts` — development values
- Modify: `angular.json` — file replacement for the development configuration

> **Three files, not two, and the reason is `fileReplacements`.** Under the
> development configuration Angular replaces `environment.ts` *wholesale* with
> `environment.development.ts`. So the development file cannot import the
> `Environment` interface from `./environment` — that import resolves to
> itself and fails `TS2724`. The interface therefore lives in a third file
> outside the replacement, and **that file is its only export site**: neither
> `environment.ts` nor `environment.development.ts` re-exports the type. An
> asymmetric re-export compiles under the production build and fails under
> `ng serve`, which is the one build a developer runs all day.
>
> Consumers import the *value* from `@core/config/environment` and, on the rare
> occasion they need the *type*, from `@core/config/environment.model`.

**Interfaces:**
- Produces: `environment: { production: boolean; gatewayBaseUrl: string; auth: { issuer: string; webClientId: string; nativeClientId: string; redirectUri: string; nativeRedirectUri: string; scope: string } }`

- [ ] **Step 1: Write the interface and the production config**

The interface goes in `src/app/core/config/environment.model.ts` and the `environment` constant below it in `src/app/core/config/environment.ts`, which imports the type with `import type { Environment } from './environment.model';` and does **not** re-export it:

```ts
/**
 * The client's whole configuration surface. Two clients and one authority,
 * because the realm has two clients and one authority
 * (deploy/compose/keycloak/realm-export.json): `web-app` for the browser,
 * `mobile-app` for Android and iOS. Which one is used is decided once, by the
 * factory in core/auth/auth.providers.ts, and nowhere else (spec §4).
 */
export interface Environment {
  readonly production: boolean;

  /** The gateway is the only host the client calls for platform data (spec §2). */
  readonly gatewayBaseUrl: string;

  readonly auth: {
    /** Keycloak realm URL. Must match the `iss` claim the realm mints. */
    readonly issuer: string;
    /** Realm client `web-app`: public, PKCE S256, no refresh token. */
    readonly webClientId: string;
    /** Realm client `mobile-app`: public, PKCE S256, rotating refresh token. */
    readonly nativeClientId: string;
    /** Browser redirect. Must appear in the realm client's `redirectUris`. */
    readonly redirectUri: string;
    /** Custom scheme the system browser returns to on native (spec §4.2). */
    readonly nativeRedirectUri: string;
    /**
     * `commerce-api` carries the audience mapper and the `permission` claim
     * mapper; without it the token is refused by every service.
     */
    readonly scope: string;
  };
}

export const environment: Environment = {
  production: true,
  gatewayBaseUrl: 'https://gateway.example.invalid',
  auth: {
    issuer: 'https://keycloak.example.invalid/realms/commerce',
    webClientId: 'web-app',
    nativeClientId: 'mobile-app',
    redirectUri: 'https://app.example.invalid/',
    nativeRedirectUri: 'blueprint://auth/callback',
    scope: 'openid profile email commerce-api',
  },
};
```

- [ ] **Step 2: Write the development config**

`src/app/core/config/environment.development.ts`:

```ts
import type { Environment } from './environment.model';

/**
 * Every value here is read from the backend's Compose stack rather than chosen:
 * - gateway 5000       deploy/compose/services/gateway.yml:34
 * - Keycloak 8080      deploy/compose/infrastructure.yml (KC_HOSTNAME)
 * - redirect 5173      realm-export.json, web-app.redirectUris + webOrigins,
 *                      and gateway.yml:32's Cors__Origins__0
 * A client that needed any of these changed would be a client the backend has
 * to accommodate, which is backwards.
 */
export const environment: Environment = {
  production: false,
  gatewayBaseUrl: 'http://localhost:5000',
  auth: {
    issuer: 'http://localhost:8080/realms/commerce',
    webClientId: 'web-app',
    nativeClientId: 'mobile-app',
    redirectUri: 'http://localhost:5173/',
    nativeRedirectUri: 'blueprint://auth/callback',
    scope: 'openid profile email commerce-api',
  },
};
```

- [ ] **Step 3: Wire the file replacement**

In `angular.json`, under `architect.build.configurations.development`:

```json
"fileReplacements": [
  {
    "replace": "src/app/core/config/environment.ts",
    "with": "src/app/core/config/environment.development.ts"
  }
]
```

- [ ] **Step 4: Verify both build**

Run: `npm run build -- --configuration=development && npm run build`
Expected: both succeed.

- [ ] **Step 5: Commit**

```bash
git add src/app/core/config angular.json
git commit -m "feat(config): gateway and Keycloak configuration per platform"
```

---

## Task 3: Wire types

**Files:**
- Create: `src/app/core/api/types.ts`
- Test: `src/app/core/api/types.spec.ts`

**Interfaces:**
- Produces: `CursorPage<T>`, `ProductSummary`, `PublishProductCommand`, `QuoteResponse`, `QuoteLine`, `PlaceOrderCommand`, `PlaceOrderItem`, `Address`, `CancelOrderRequest`, `CANCEL_REASONS`, `CancelReason`, `PERMISSIONS`.

- [ ] **Step 1: Write the types**

`src/app/core/api/types.ts`:

```ts
/**
 * The wire shapes, hand-written, one interface per backend record, each citing
 * the file and symbol it mirrors (spec §1, property 2; spec §3, "Types").
 * Generation from the OpenAPI documents was considered and deferred: the BFF
 * publishes no document, six endpoints do not pay for the tooling, and a
 * citing comment is what lets grep find drift in either direction.
 *
 * Field names are camelCase because that is what ASP.NET Core's default
 * JsonSerializerOptions produces, not because the client prefers it.
 */

/** Common.Application/CursorPage.cs — `CursorPage<T>`. Null `nextCursor` is the last page. */
export interface CursorPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

/** Catalog.Application/Products/GetProducts/ProductSummaryDto.cs — `ProductSummaryDto`. */
export interface ProductSummary {
  readonly productId: string;
  readonly name: string;
  readonly thumbnailUrl: string | null;
  readonly amount: number;
  readonly currency: string;
  /** DateTimeOffset on the wire; the client only ever displays it. */
  readonly publishedAt: string;
}

/** Catalog.Application/Products/PublishProduct/PublishProductCommand.cs — `PublishProductCommand`. */
export interface PublishProductCommand {
  readonly commandId: string;
  readonly name: string;
  readonly thumbnailUrl: string | null;
  /**
   * `decimal?` on the backend, and the nullability is load-bearing there: an
   * omitted amount would bind as 0 and publish a free product. The client
   * always sends a number, so the type is not optional here — but it must
   * never send `null` to mean "the user left it blank", because the backend's
   * validator turns that into a field-keyed 400 which is exactly right.
   */
  readonly amount: number;
  readonly currency: string;
}

/** Web.Bff/Endpoints/QuoteResponse.cs — `QuoteLine`. */
export interface QuoteLine {
  readonly productId: string;
  readonly name: string;
  readonly amount: number;
}

/** Web.Bff/Endpoints/QuoteResponse.cs — `QuoteResponse`. */
export interface QuoteResponse {
  readonly currency: string;
  readonly lines: readonly QuoteLine[];
  /**
   * The BFF's own sum. Spec §5.2: shown as sent, never recomputed — two places
   * computing a total is two places to get rounding wrong, which is the reason
   * QuoteResponse.cs gives for computing it there at all.
   */
  readonly total: number;
  /** Products asked about that Catalog returned no price for. Named, not omitted. */
  readonly unpriced: readonly string[];
}

/** Ordering.Application/Orders/PlaceOrder/PlaceOrderCommand.cs — `PlaceOrderItem`. */
export interface PlaceOrderItem {
  readonly productId: string;
  readonly quantity: number;
}

/** Ordering.Application/Orders/PlaceOrder/PlaceOrderCommand.cs — `AddressDto`. */
export interface Address {
  readonly line1: string;
  readonly line2: string | null;
  readonly city: string;
  readonly postalCode: string;
  readonly country: string;
}

/**
 * Ordering.Application/Orders/PlaceOrder/PlaceOrderCommand.cs — `PlaceOrderCommand`.
 * There is no customerId, and the omission is the backend's control: the
 * subject of a write is bound from the principal and never from the request.
 * A client that added one would be handing the platform a field it refuses.
 */
export interface PlaceOrderCommand {
  readonly commandId: string;
  readonly items: readonly PlaceOrderItem[];
  readonly shippingAddress: Address;
  readonly currency: string;
}

/** Ordering.Api/Endpoints/OrderEndpoints.cs — `CancelOrderRequest`. */
export interface CancelOrderRequest {
  readonly reason: CancelReason;
}

/**
 * Common.Contracts/Ordering/V1/Commands.cs — `CancelReasons`. A frozen list,
 * in the backend's declaration order. The backend refuses a code it does not
 * know rather than defaulting, so a client inventing a sixth would get a
 * field-keyed 400 naming `Reason` — which is the right answer and still a bug
 * on this side.
 */
export const CANCEL_REASONS = [
  'out_of_stock',
  'stock_timeout',
  'payment_declined',
  'payment_timeout',
  'customer_request',
] as const;

export type CancelReason = (typeof CANCEL_REASONS)[number];

/**
 * Catalog.Api/CatalogPermissions.cs and Ordering.Api/OrderingPermissions.cs.
 * Claims, not roles: the `commerce-api` client scope maps a multivalued
 * `permission` claim and `RequireClaim` reads it. There is no `catalog:read`
 * and no `orders:read` — a permission nothing requires is a dead name in the
 * realm, and both files say so explicitly.
 */
export const PERMISSIONS = {
  catalogWrite: 'catalog:write',
  ordersWrite: 'orders:write',
  ordersCancel: 'orders:cancel',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
```

- [ ] **Step 2: Write the drift test**

`src/app/core/api/types.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CANCEL_REASONS, PERMISSIONS } from './types';

/**
 * These two vocabularies are the ones a screen renders directly, so a drift
 * from the backend shows up as a wrong dropdown or a hidden button rather than
 * as a type error. The e2e smoke exercises them against the real realm; this
 * catches a typo without Docker.
 */
describe('backend vocabularies', () => {
  it('holds the five cancellation reasons in Commands.cs order', () => {
    expect(CANCEL_REASONS).toEqual([
      'out_of_stock',
      'stock_timeout',
      'payment_declined',
      'payment_timeout',
      'customer_request',
    ]);
  });

  it('holds the three permissions the realm grants demo', () => {
    expect(Object.values(PERMISSIONS)).toEqual([
      'catalog:write',
      'orders:write',
      'orders:cancel',
    ]);
  });
});
```

- [ ] **Step 3: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/app/core/api/types.ts src/app/core/api/types.spec.ts
git commit -m "feat(api): wire types citing their backend owners"
```

---
## Task 4: Problem details and the error mapper

The one place a failed request becomes something a screen shows (spec §6). Every later task depends on the display model, so this comes before any API client.

**Files:**
- Create: `src/app/core/errors/problem-details.ts`
- Create: `src/app/core/errors/error-mapper.ts`
- Create: `src/app/shared/error-banner.component.ts`
- Test: `src/app/core/errors/error-mapper.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `ProblemDetails` — the RFC 9457 body plus the backend's `code`, `correlationId`, `traceId`, `errors`.
  - `type DisplayError = { kind: ErrorKind; title: string; detail: string | null; fields?: Readonly<Record<string, readonly string[]>>; retryAfterSeconds?: number; retryAfterIsFallback?: boolean; correlationId?: string; permission?: string }`
  - `type ErrorKind = 'validation' | 'banner' | 'signIn' | 'forbidden' | 'alreadyCommitted' | 'inProgress' | 'concurrencyConflict' | 'rule' | 'rateLimited' | 'unavailable' | 'retry'`
  - `mapError(error: HttpErrorResponse, context?: { permission?: string }): DisplayError`
  - `RATE_LIMIT_FALLBACK_SECONDS = 60`

- [ ] **Step 1: Write the problem-details shape**

`src/app/core/errors/problem-details.ts`:

```ts
/**
 * RFC 9457, as the platform sends it. `title` and `detail` are the backend's
 * words and are rendered as sent (spec §6) — the client authors no error text
 * beyond the six generic banners.
 *
 * The three extension members are Common.Web's, not the RFC's:
 *   code           the stable identifier a client switches on. ResultExtensions.cs
 *                  puts Error.Code here; the three 409 handlers put their own.
 *                  RFC 9457 makes `detail` human-readable, so switching on prose
 *                  is what this member exists to prevent.
 *   correlationId  ProblemDetailsExtensions.cs:57. Read from the BODY and never
 *                  from the X-Correlation-Id header: that header is not
 *                  CORS-safelisted and the gateway does not expose it, so
 *                  script cannot see it cross-origin.
 *   traceId        ProblemDetailsExtensions.cs:60.
 */
export interface ProblemDetails {
  readonly type?: string;
  readonly title?: string;
  readonly status?: number;
  readonly detail?: string;
  readonly code?: string;
  readonly correlationId?: string;
  readonly traceId?: string;
  /** ValidationProblemDetails only. Keyed by field, as ValidationExceptionHandler.cs:35 builds it. */
  readonly errors?: Readonly<Record<string, readonly string[]>>;
}

export function isProblemDetails(body: unknown): body is ProblemDetails {
  return typeof body === 'object' && body !== null && !Array.isArray(body);
}
```

- [ ] **Step 2: Write the failing mapper tests**

`src/app/core/errors/error-mapper.spec.ts`. One fixture per row of spec §6, plus the three 409s the backend actually has:

```ts
import { HttpErrorResponse } from '@angular/common/http';
import { describe, expect, it } from 'vitest';
import { RATE_LIMIT_FALLBACK_SECONDS, mapError } from './error-mapper';
import { ProblemDetails } from './problem-details';

function problem(status: number, body: ProblemDetails, headers?: Record<string, string>) {
  return new HttpErrorResponse({
    status,
    statusText: '',
    url: 'http://localhost:5000/api/v1/orders',
    error: body,
    headers: headers
      ? ({ get: (name: string) => headers[name] ?? null } as never)
      : undefined,
  });
}

describe('mapError', () => {
  it('400 with errors becomes a validation model keyed by field', () => {
    const result = mapError(
      problem(400, {
        title: 'One or more validation errors occurred.',
        status: 400,
        errors: { Name: ['Name is required.'], Amount: ['Amount must be positive.'] },
        correlationId: 'c-1',
      }),
    );

    expect(result.kind).toBe('validation');
    expect(result.fields).toEqual({
      Name: ['Name is required.'],
      Amount: ['Amount must be positive.'],
    });
    expect(result.correlationId).toBe('c-1');
  });

  it('400 without errors becomes a banner carrying the backend title and detail', () => {
    const result = mapError(
      problem(400, {
        title: 'No products to price',
        detail: 'A quote needs at least one productId.',
        status: 400,
      }),
    );

    expect(result).toMatchObject({
      kind: 'banner',
      title: 'No products to price',
      detail: 'A quote needs at least one productId.',
    });
  });

  it('401 becomes signIn', () => {
    expect(mapError(problem(401, { title: 'Unauthorized', status: 401 })).kind).toBe('signIn');
  });

  it('403 names the permission from the caller, not from the response', () => {
    const result = mapError(problem(403, { title: 'Forbidden', status: 403 }), {
      permission: 'catalog:write',
    });

    expect(result.kind).toBe('forbidden');
    expect(result.permission).toBe('catalog:write');
  });

  it('404 becomes a banner with the backend text', () => {
    const result = mapError(problem(404, { title: 'Not Found', detail: 'No such order.', status: 404 }));

    expect(result).toMatchObject({ kind: 'banner', title: 'Not Found', detail: 'No such order.' });
  });

  it('409 command.already_committed must not be retried', () => {
    const result = mapError(
      problem(409, {
        status: 409,
        code: 'command.already_committed',
        detail:
          'This command has already been applied and its result is no longer available; read the resource rather than retrying.',
      }),
    );

    expect(result.kind).toBe('alreadyCommitted');
    expect(result.detail).toContain('already been applied');
  });

  it('409 request.in_progress is a distinct kind that invites a retry', () => {
    const result = mapError(
      problem(409, {
        status: 409,
        code: 'request.in_progress',
        detail: 'A request with this command identifier is already in progress. Retry.',
      }),
    );

    expect(result.kind).toBe('inProgress');
  });

  it('409 request.concurrency_conflict is a third distinct kind', () => {
    const result = mapError(
      problem(409, {
        status: 409,
        code: 'request.concurrency_conflict',
        detail: 'The resource was modified by another request. Re-read it and retry.',
      }),
    );

    expect(result.kind).toBe('concurrencyConflict');
  });

  it('409 with no code falls back to the most cautious of the three', () => {
    expect(mapError(problem(409, { status: 409 })).kind).toBe('alreadyCommitted');
  });

  it('422 shows the backend title and detail verbatim', () => {
    const result = mapError(
      problem(422, {
        title: 'Unprocessable Entity',
        detail: 'An order must hold at least one item.',
        status: 422,
        code: 'order.empty',
      }),
    );

    expect(result).toMatchObject({
      kind: 'rule',
      title: 'Unprocessable Entity',
      detail: 'An order must hold at least one item.',
    });
  });

  it('429 parses Retry-After when the gateway exposes it', () => {
    const result = mapError(
      problem(429, { title: 'Too many requests', status: 429 }, { 'Retry-After': '17' }),
    );

    expect(result.kind).toBe('rateLimited');
    expect(result.retryAfterSeconds).toBe(17);
    expect(result.retryAfterIsFallback).toBe(false);
  });

  it('429 falls back and says so when Retry-After is unreadable', () => {
    const result = mapError(problem(429, { title: 'Too many requests', status: 429 }));

    expect(result.retryAfterSeconds).toBe(RATE_LIMIT_FALLBACK_SECONDS);
    expect(result.retryAfterIsFallback).toBe(true);
  });

  it('503 becomes unavailable', () => {
    expect(mapError(problem(503, { title: 'Service Unavailable', status: 503 })).kind).toBe(
      'unavailable',
    );
  });

  it('500 becomes retry and carries the correlation id from the body', () => {
    const result = mapError(
      problem(500, { title: 'An error occurred', status: 500, correlationId: 'abc-123' }),
    );

    expect(result.kind).toBe('retry');
    expect(result.correlationId).toBe('abc-123');
  });

  it('a network failure is status 0 and maps to retry with no correlation id', () => {
    const result = mapError(
      new HttpErrorResponse({ status: 0, statusText: 'Unknown Error', error: new ProgressEvent('error') }),
    );

    expect(result.kind).toBe('retry');
    expect(result.correlationId).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run and watch every test fail**

Run: `npm test -- error-mapper`
Expected: FAIL — `Failed to resolve import "./error-mapper"`.

- [ ] **Step 4: Write the mapper**

`src/app/core/errors/error-mapper.ts`:

```ts
import { HttpErrorResponse } from '@angular/common/http';
import { ProblemDetails, isProblemDetails } from './problem-details';

/**
 * The six generic banners spec §6 permits the client to author, plus the two
 * extra 409 kinds the backend actually distinguishes. Everything else on
 * screen is the backend's own `title` and `detail`, shown as sent.
 */
export type ErrorKind =
  | 'validation'
  | 'banner'
  | 'signIn'
  | 'forbidden'
  | 'alreadyCommitted'
  | 'inProgress'
  | 'concurrencyConflict'
  | 'rule'
  | 'rateLimited'
  | 'unavailable'
  | 'retry';

export interface DisplayError {
  readonly kind: ErrorKind;
  readonly title: string;
  readonly detail: string | null;
  /** 400 only, keyed exactly as the backend keyed it. */
  readonly fields?: Readonly<Record<string, readonly string[]>>;
  readonly retryAfterSeconds?: number;
  /**
   * True when the countdown is this client's guess rather than the gateway's
   * number. The banner says so: a countdown presented as fact when it is a
   * fallback is a lie the user cannot detect.
   */
  readonly retryAfterIsFallback?: boolean;
  readonly correlationId?: string;
  /** 403 only. Taken from the route's metadata, never from the response. */
  readonly permission?: string;
}

/**
 * Used when the gateway has not yet been taught to expose Retry-After
 * (Task 0, step 2). The limiter's real budget is 300 tokens per minute, so a
 * minute is the honest round number to wait rather than a tuned guess.
 */
export const RATE_LIMIT_FALLBACK_SECONDS = 60;

/** Backend codes on the 409 row. Common.Web's three handlers, verbatim. */
const CONFLICT_KINDS: Readonly<Record<string, ErrorKind>> = {
  'request.in_progress': 'inProgress',
  'command.already_committed': 'alreadyCommitted',
  'request.concurrency_conflict': 'concurrencyConflict',
};

export function mapError(
  error: unknown,
  context?: { readonly permission?: string },
): DisplayError {
  if (!(error instanceof HttpErrorResponse)) {
    // angular-oauth2-oidc's loadDiscoveryDocument() — and therefore
    // WebAuthStrategy.signIn(), which awaits it — can reject with a bare
    // string rather than an Error, let alone an HttpErrorResponse: there is
    // no HTTP response here to read a status or a body from. Every call site
    // before cart.page.ts's sign-in retry was an HttpClient error handler,
    // where `HttpErrorResponse` was actually true; that caller breaks the
    // assumption, so the parameter widens to `unknown` and this branch is
    // what keeps it from a runtime TypeError reading `.status` off a string.
    return { kind: 'retry', title: '', detail: null };
  }

  const body: ProblemDetails = isProblemDetails(error.error) ? error.error : {};
  const title = body.title ?? '';
  const detail = body.detail ?? null;
  const correlationId = body.correlationId;

  const base = { title, detail, correlationId } as const;

  switch (error.status) {
    case 400:
      return body.errors
        ? { ...base, kind: 'validation', fields: body.errors }
        : { ...base, kind: 'banner' };

    case 401:
      // The caller invokes AuthService.signIn() and replays. Nothing is
      // decided here, because only the caller knows what to replay.
      return { ...base, kind: 'signIn' };

    case 403:
      // The permission comes from the route's own metadata. A hidden button
      // and a refused call are two different facts (spec §4.3), and the
      // response deliberately does not name a permission — echoing one would
      // be the backend describing its own policy to an unauthorised caller.
      return { ...base, kind: 'forbidden', permission: context?.permission };

    case 404:
      return { ...base, kind: 'banner' };

    case 409:
      // Switching on `code`, not on `detail`. The three producers carry
      // instructions that contradict each other — one says retry, one says do
      // not — and RFC 9457 makes `detail` human-readable, so a client told
      // them apart by English would break on a reword. An absent code takes
      // the kind that forbids the retry: guessing "retry" on a command that
      // already committed is the one wrong answer that places a second order.
      return {
        ...base,
        kind: (body.code && CONFLICT_KINDS[body.code]) || 'alreadyCommitted',
      };

    case 422:
      return { ...base, kind: 'rule' };

    case 429: {
      // Gated on the trimmed string being non-empty, NOT on the parsed
      // number being truthy. Number('') and Number('   ') are both 0, so a
      // present-but-empty header would otherwise pass `isFinite(0) && 0 >= 0`
      // and be reported as a real zero-second countdown — the exact lie
      // retryAfterIsFallback exists to prevent. A genuine '0' is still
      // readable, because a non-empty string is truthy: the gateway can send
      // zero when a bucket has under a second left.
      //
      // A non-numeric value, including the HTTP-date form the spec allows and
      // this gateway never sends, becomes NaN and falls back. That is why no
      // date parsing appears here.
      const header = error.headers?.get('Retry-After');
      const trimmed = header?.trim();
      const parsed = trimmed ? Number(trimmed) : Number.NaN;
      const readable = Number.isFinite(parsed) && parsed >= 0;

      return {
        ...base,
        kind: 'rateLimited',
        retryAfterSeconds: readable ? parsed : RATE_LIMIT_FALLBACK_SECONDS,
        retryAfterIsFallback: !readable,
      };
    }

    case 503:
      return { ...base, kind: 'unavailable' };

    default:
      // Every other 5xx, plus status 0 — a network failure, a timeout, a CORS
      // rejection. There is no body on those, so there is no correlation id to
      // carry, and `base` already reflects that.
      return { ...base, kind: 'retry' };
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `npm test -- error-mapper`
Expected: PASS, 15 tests.

- [ ] **Step 6: Write the banner component**

`src/app/shared/error-banner.component.ts`. This file holds every string the client authors; nothing else in the application writes error prose.

```ts
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { IonIcon, IonNote, IonText } from '@ionic/angular';
import { DisplayError, ErrorKind } from '@core/errors/error-mapper';

/**
 * The six generic banners spec §6 permits, plus one each for the two extra
 * 409s the backend distinguishes. Where the backend sends `title` and
 * `detail`, they are shown as sent and these are not used.
 */
const GENERIC: Readonly<Record<ErrorKind, string | null>> = {
  validation: null,
  banner: null,
  rule: null,
  signIn: 'Sign in to continue.',
  forbidden: 'Your account does not hold the permission this action needs.',
  alreadyCommitted: 'This request was already applied. It has not been sent again.',
  inProgress: 'An identical request is still in flight. Try again in a moment.',
  concurrencyConflict: 'Someone else changed this while you were working. Reload and try again.',
  rateLimited: 'Too many requests.',
  unavailable: 'The service is temporarily unavailable.',
  retry: 'Something went wrong.',
};

@Component({
  selector: 'app-error-banner',
  standalone: true,
  imports: [IonIcon, IonNote, IonText],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (error(); as e) {
      <div class="banner" role="alert" [attr.data-kind]="e.kind">
        <ion-icon name="alert-circle-outline" aria-hidden="true"></ion-icon>

        <div>
          <ion-text><strong>{{ heading() }}</strong></ion-text>

          @if (e.detail) {
            <p>{{ e.detail }}</p>
          }

          @if (e.permission) {
            <p>Needed: <code>{{ e.permission }}</code></p>
          }

          @if (e.fields) {
            <ul>
              @for (field of fieldEntries(); track field[0]) {
                <li><strong>{{ field[0] }}</strong>: {{ field[1].join(' ') }}</li>
              }
            </ul>
          }

          @if (e.kind === 'rateLimited') {
            <p>
              Retry in {{ e.retryAfterSeconds }}s.
              @if (e.retryAfterIsFallback) {
                <ion-note>
                  The gateway did not expose Retry-After to this origin, so that is an estimate.
                </ion-note>
              }
            </p>
          }

          @if (e.correlationId) {
            <ion-note>Correlation id: <code>{{ e.correlationId }}</code></ion-note>
          }
        </div>
      </div>
    }
  `,
  styles: `
    .banner { display: flex; gap: .75rem; padding: .75rem 1rem; border-radius: .5rem;
              background: var(--ion-color-danger-tint); color: var(--ion-color-danger-contrast); }
    ul { margin: .25rem 0 0; padding-left: 1.25rem; }
    p { margin: .25rem 0 0; }
  `,
})
export class ErrorBannerComponent {
  readonly error = input.required<DisplayError | null>();

  /**
   * The backend's title wins whenever it sent one; the generic is the fallback.
   *
   * Branches on null explicitly rather than asserting it away. `error` is a
   * required input typed `DisplayError | null`, so null is a legal value, and
   * a non-null assertion here is a TypeError waiting for the first caller that
   * reads this outside the template's `@if` guard.
   */
  protected readonly heading = computed(() => {
    const e = this.error();
    return e ? e.title || GENERIC[e.kind] || 'Something went wrong.' : 'Something went wrong.';
  });

  protected readonly fieldEntries = computed(() => Object.entries(this.error()?.fields ?? {}));
}
```

- [ ] **Step 7: Verify lint and tests**

Run: `npm run lint && npm test`
Expected: both pass.

- [ ] **Step 8: Commit**

```bash
git add src/app/core/errors src/app/shared/error-banner.component.ts
git commit -m "feat(errors): map every backend status to one display model"
```

---

## Task 5: Identity

**Files:**
- Create: `src/app/core/auth/auth.service.ts`
- Create: `src/app/core/auth/current-user.ts`
- Create: `src/app/core/auth/web-auth.strategy.ts`
- Create: `src/app/core/auth/auth.interceptor.ts`
- Create: `src/app/core/auth/permission.guard.ts`
- Create: `src/app/core/auth/auth.providers.ts`
- Test: `src/app/core/auth/current-user.spec.ts`, `auth.interceptor.spec.ts`, `web-auth.strategy.spec.ts`, `permission.guard.spec.ts`

**Interfaces:**
- Consumes: `environment` (Task 2), `PERMISSIONS` (Task 3).
- Produces:
  - `abstract class AuthService { signIn(): Promise<void>; signOut(): Promise<void>; accessToken(): string | null; user(): Signal<CurrentUser | null>; hasPermission(name: string): boolean; }`
  - `interface CurrentUser { username: string; subject: string; permissions: readonly string[]; expiresAt: number }`
  - `decodeUser(token: string): CurrentUser | null`
  - `authInterceptor: HttpInterceptorFn`
  - `permissionGuard(permission: string): CanActivateFn`
  - `provideAuth(): EnvironmentProviders`

- [ ] **Step 1: Install the OIDC library**

Nothing before this task needs it, so it arrives here rather than in the
scaffold — a dependency installed by the task that first imports it is a
dependency whose reason is visible in one place.

```bash
npm install --save-exact angular-oauth2-oidc@22.0.2
```

`--save-exact` because the plan pins every version with no `^` or `~`. Confirm
afterwards that `package.json` records `"angular-oauth2-oidc": "22.0.2"` with no
range prefix.

- [ ] **Step 2: Write the interface**

`src/app/core/auth/auth.service.ts`:

```ts
import { Signal } from '@angular/core';

/** The claims the client reads, and nothing else the token carries. */
export interface CurrentUser {
  readonly username: string;
  readonly subject: string;
  /**
   * The `permission` claim: multivalued String, mapped from `commerce-api`
   * client roles by the realm's protocol mapper. Claims, not roles — the
   * client reads exactly what RequireClaim reads (spec §2.1, §4.3).
   */
  readonly permissions: readonly string[];
  /** `exp`, in epoch seconds. Read from the token so a realm change moves the schedule. */
  readonly expiresAt: number;
}

/**
 * One interface, two implementations, one factory (spec §4). Nothing in the
 * application asks which platform it is on; auth.providers.ts asks once.
 * Abstract class rather than an InjectionToken plus interface, because Angular
 * can then use the class itself as the token and a component's constructor
 * reads as the dependency it is.
 */
export abstract class AuthService {
  /**
   * Called once by the application initialiser. On the web it completes a
   * pending code flow; on native it restores a refresh token from secure
   * storage. It is on the interface rather than on each strategy because the
   * initialiser must call it without knowing which one it got — a cast there
   * would defeat the one-interface property §4 rests on.
   */
  abstract initialize(): Promise<void>;
  abstract signIn(): Promise<void>;
  abstract signOut(): Promise<void>;
  /** Null when signed out. Callers attach it; nobody stores it. */
  abstract accessToken(): string | null;
  abstract user(): Signal<CurrentUser | null>;
  abstract hasPermission(name: string): boolean;
  /**
   * True on the web, where a reload signs the user out because the realm
   * issues no refresh token and nothing is written to storage. The account
   * page states the consequence rather than hiding it (spec §5.6).
   */
  abstract readonly sessionEndsOnReload: boolean;
}
```

- [ ] **Step 2: Write the failing claims test**

`src/app/core/auth/current-user.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { decodeUser } from './current-user';

/** Builds an unsigned JWT. The client never verifies a signature — the platform does. */
function token(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(payload)}.signature`;
}

describe('decodeUser', () => {
  it('reads preferred_username, sub, permission and exp', () => {
    const user = decodeUser(
      token({
        preferred_username: 'demo',
        sub: '00000000-0000-0000-0000-000000000001',
        permission: ['catalog:write', 'orders:write', 'orders:cancel'],
        exp: 1_800_000_300,
      }),
    );

    expect(user).toEqual({
      username: 'demo',
      subject: '00000000-0000-0000-0000-000000000001',
      permissions: ['catalog:write', 'orders:write', 'orders:cancel'],
      expiresAt: 1_800_000_300,
    });
  });

  it('treats a single-valued permission claim as one permission', () => {
    // Keycloak collapses a multivalued claim to a scalar when there is one
    // value, so the browser user holding exactly one permission would
    // otherwise decode as a string being spread into characters.
    expect(decodeUser(token({ preferred_username: 'x', sub: 's', permission: 'orders:write', exp: 1 }))
      ?.permissions).toEqual(['orders:write']);
  });

  it('yields an empty permission list when the claim is absent', () => {
    // The `browser` user holds no client roles, so the mapper emits nothing.
    expect(decodeUser(token({ preferred_username: 'browser', sub: 's', exp: 1 }))?.permissions)
      .toEqual([]);
  });

  it('returns null for a token that is not a JWT', () => {
    expect(decodeUser('not-a-token')).toBeNull();
  });
});
```

- [ ] **Step 3: Run and watch it fail**

Run: `npm test -- current-user`
Expected: FAIL — cannot resolve `./current-user`.

- [ ] **Step 4: Write the decoder**

`src/app/core/auth/current-user.ts`:

```ts
import { CurrentUser } from './auth.service';

/**
 * Decodes the access token's claims. It does NOT verify the signature: every
 * host validates its own tokens (the backend's §11.2), and a client that
 * checked one would be asserting something it cannot enforce. What is read
 * here decides what is shown, never what is allowed — the guard hides, the
 * backend decides (spec §4.3).
 */
export function decodeUser(accessToken: string): CurrentUser | null {
  const segments = accessToken.split('.');
  if (segments.length !== 3) return null;

  try {
    const payload = JSON.parse(base64UrlDecode(segments[1])) as Record<string, unknown>;

    return {
      username: String(payload['preferred_username'] ?? ''),
      subject: String(payload['sub'] ?? ''),
      permissions: toPermissions(payload['permission']),
      expiresAt: Number(payload['exp'] ?? 0),
    };
  } catch {
    return null;
  }
}

/**
 * Keycloak's multivalued mapper emits an array for two or more values and a
 * bare string for one. Spreading the scalar case would turn "orders:write"
 * into eleven single-character permissions, none of which match anything — a
 * button that silently stays hidden for the user who has exactly one grant.
 */
function toPermissions(claim: unknown): readonly string[] {
  if (Array.isArray(claim)) return claim.map(String);
  if (typeof claim === 'string' && claim.length > 0) return [claim];
  return [];
}

function base64UrlDecode(segment: string): string {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/').padEnd(
    segment.length + ((4 - (segment.length % 4)) % 4),
    '=',
  );

  // decodeURIComponent/escape round-trip, so a username outside Latin-1
  // survives. atob alone mangles it.
  return decodeURIComponent(
    Array.from(atob(padded), (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join(''),
  );
}
```

- [ ] **Step 5: Run the tests**

Run: `npm test -- current-user`
Expected: PASS, 4 tests.

- [ ] **Step 6: Write the failing interceptor test**

`src/app/core/auth/auth.interceptor.spec.ts`:

```ts
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from './auth.service';
import { authInterceptor } from './auth.interceptor';

class StubAuth {
  accessToken = () => 'the-token';
}

describe('authInterceptor', () => {
  let http: HttpClient;
  let controller: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        { provide: AuthService, useClass: StubAuth },
      ],
    });

    http = TestBed.inject(HttpClient);
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => controller.verify());

  it('attaches the bearer token to gateway requests', () => {
    http.get('http://localhost:5000/api/v1/orders').subscribe();

    expect(controller.expectOne('http://localhost:5000/api/v1/orders').request.headers.get('Authorization'))
      .toBe('Bearer the-token');
  });

  it('attaches nothing to the Keycloak host', () => {
    // A request to the identity provider must never carry the platform's
    // token: the two are different audiences and one is not the other's
    // business.
    http.get('http://localhost:8080/realms/commerce/protocol/openid-connect/token').subscribe();

    expect(
      controller
        .expectOne('http://localhost:8080/realms/commerce/protocol/openid-connect/token')
        .request.headers.has('Authorization'),
    ).toBe(false);
  });

  it('attaches nothing to a host that merely starts with the same characters', () => {
    http.get('http://localhost:50001/api/v1/orders').subscribe();

    expect(controller.expectOne('http://localhost:50001/api/v1/orders').request.headers.has('Authorization'))
      .toBe(false);
  });
});
```

- [ ] **Step 7: Run and watch it fail**

Run: `npm test -- auth.interceptor`
Expected: FAIL — cannot resolve `./auth.interceptor`.

- [ ] **Step 8: Write the interceptor**

`src/app/core/auth/auth.interceptor.ts`:

```ts
import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { environment } from '@core/config/environment';
import { AuthService } from './auth.service';

/**
 * Attaches the bearer to requests bound for the gateway, and to nothing else
 * (spec §4.3). The URL is compared against the configured base with a boundary
 * check rather than a bare startsWith, because "http://localhost:5000" is a
 * prefix of "http://localhost:50001" and a token sent to the wrong host is a
 * token leaked to it.
 */
export const authInterceptor: HttpInterceptorFn = (request, next) => {
  const base = environment.gatewayBaseUrl.replace(/\/+$/, '');
  const url = request.url;
  const forGateway = url === base || url.startsWith(`${base}/`) || url.startsWith(`${base}?`);

  if (!forGateway) return next(request);

  const token = inject(AuthService).accessToken();
  if (!token) return next(request);

  return next(request.clone({ setHeaders: { Authorization: `Bearer ${token}` } }));
};
```

- [ ] **Step 9: Run the tests**

Run: `npm test -- auth.interceptor`
Expected: PASS, 3 tests.

- [ ] **Step 10: Write the web strategy**

`src/app/core/auth/web-auth.strategy.ts`:

```ts
import { Injectable, Signal, computed, inject, signal } from '@angular/core';
import { AuthConfig, OAuthService, OAuthStorage } from 'angular-oauth2-oidc';
import { environment } from '@core/config/environment';
import { AuthService, CurrentUser } from './auth.service';
import { decodeUser } from './current-user';

/** The only three values that must survive the sign-in redirect. */
const TRANSIENT_STORAGE_KEYS = new Set(['PKCE_verifier', 'nonce', 'requested_route']);

/**
 * sessionStorage for the transient keys, memory for everything else — every
 * token and every piece of session bookkeeping. sessionStorage rather than
 * localStorage because it dies with the tab, which is closer to the posture
 * the realm chose.
 */
export class HybridOAuthStorage implements OAuthStorage {
  private readonly memory = new Map<string, string>();

  getItem(key: string): string | null {
    return TRANSIENT_STORAGE_KEYS.has(key)
      ? sessionStorage.getItem(key)
      : this.memory.get(key) ?? null;
  }

  setItem(key: string, data: string): void {
    if (TRANSIENT_STORAGE_KEYS.has(key)) sessionStorage.setItem(key, data);
    else this.memory.set(key, data);
  }

  removeItem(key: string): void {
    if (TRANSIENT_STORAGE_KEYS.has(key)) sessionStorage.removeItem(key);
    else this.memory.delete(key);
  }
}

/**
 * The browser half of spec §4.1.
 *
 * Tokens are held in memory only — no localStorage, no sessionStorage. A page
 * reload signs the user out, and that is the honest consequence of the realm's
 * `use.refresh.tokens: "false"` on `web-app` rather than an oversight; the
 * account page says so in a sentence (spec §5.6).
 *
 * Renewal is a silent code flow in a hidden iframe with prompt=none, because
 * there IS no refresh token to use. The schedule comes from the token's own
 * `exp`, so moving accessTokenLifespan in the realm moves the schedule without
 * a client release.
 */
@Injectable()
export class WebAuthStrategy extends AuthService {
  readonly sessionEndsOnReload = true;

  private readonly oauth = inject(OAuthService);
  private readonly token = signal<string | null>(null);
  private readonly currentUser = computed<CurrentUser | null>(() => {
    const raw = this.token();
    return raw ? decodeUser(raw) : null;
  });

  private renewalTimer: ReturnType<typeof setTimeout> | null = null;

  /** Fraction of the token's life at which the silent renewal fires (spec §4.1). */
  private static readonly RENEW_AT = 0.75;

  async initialize(): Promise<void> {
    const config: AuthConfig = {
      issuer: environment.auth.issuer,
      clientId: environment.auth.webClientId,
      redirectUri: environment.auth.redirectUri,
      silentRefreshRedirectUri: `${environment.auth.redirectUri}silent-refresh.html`,
      responseType: 'code',
      scope: environment.auth.scope,
      // In memory only. The library's default is localStorage, and leaving it
      // there would contradict the whole posture above.
      requireHttps: environment.production,
      showDebugInformation: !environment.production,
      useSilentRefresh: true,
      // The realm mints no refresh token for this client, so there is nothing
      // for the library's refresh path to do. Saying so keeps it from trying.
      disablePKCE: false,
    };

    this.oauth.configure(config);
    // NOT MemoryStorage, and not a no-op stub. Both lose the PKCE verifier.
    //
    // initCodeFlow()'s default openUri is `location.href = uri` — a real
    // top-level navigation. createLoginUrl writes PKCE_verifier to this
    // storage BEFORE navigating; the navigation destroys the JS heap; the
    // app boots fresh; and getTokenFromCode then finds no verifier, warns,
    // and sends the code exchange WITHOUT code_verifier. A realm requiring
    // PKCE S256 rejects that, so sign-in fails after a successful login.
    //
    // So the storage routes by key, on an ALLOWLIST of the three
    // flow-transient values. The allowlist direction is the load-bearing
    // part: a key a future library version adds falls to memory, which is
    // safe, where a denylist would default it to sessionStorage — a
    // credential leak arriving through an unreviewed upgrade.
    //
    // The spec says "nothing is written to localStorage or sessionStorage".
    // Read literally that is unimplementable for a redirect flow, because
    // something must survive exactly one navigation. What it protects is
    // preserved: no credential is readable from web storage and a reload
    // still signs the user out. A PKCE verifier is a single-use,
    // non-identifying nonce, worthless without the matching code.
    this.oauth.setStorage(new HybridOAuthStorage());

    await this.oauth.loadDiscoveryDocumentAndTryLogin();

    const token = this.oauth.getAccessToken();
    if (token) this.adopt(token);
  }

  async signIn(): Promise<void> {
    this.oauth.initCodeFlow();
  }

  async signOut(): Promise<void> {
    this.clearRenewal();
    this.token.set(null);
    // Ends the Keycloak session through the end-session endpoint, not just the
    // local one: a local-only sign-out leaves the realm session alive and the
    // next sign-in silently succeeds without a prompt, which looks like the
    // sign-out did not work.
    this.oauth.logOut();
  }

  accessToken(): string | null {
    return this.token();
  }

  user(): Signal<CurrentUser | null> {
    return this.currentUser;
  }

  hasPermission(name: string): boolean {
    return this.currentUser()?.permissions.includes(name) ?? false;
  }

  private adopt(token: string): void {
    this.token.set(token);
    this.scheduleRenewal();
  }

  private scheduleRenewal(): void {
    this.clearRenewal();

    const user = this.currentUser();
    if (!user?.expiresAt) return;

    const lifetimeMs = user.expiresAt * 1000 - Date.now();
    if (lifetimeMs <= 0) return;

    this.renewalTimer = setTimeout(() => void this.renew(), lifetimeMs * WebAuthStrategy.RENEW_AT);
  }

  private async renew(): Promise<void> {
    try {
      await this.oauth.silentRefresh();
      const token = this.oauth.getAccessToken();
      if (token) this.adopt(token);
    } catch {
      // Keycloak answered login_required: the SSO session is gone. Drop the
      // token rather than retrying — the next protected action prompts an
      // interactive sign-in, which is the only thing that can help.
      this.token.set(null);
    }
  }

  private clearRenewal(): void {
    if (this.renewalTimer !== null) clearTimeout(this.renewalTimer);
    this.renewalTimer = null;
  }
}
```

Also create `public/silent-refresh.html`:

```html
<!doctype html>
<html>
  <body>
    <script>
      parent.postMessage(location.hash, location.origin);
    </script>
  </body>
</html>
```

- [ ] **Step 11: Write the strategy test**

`src/app/core/auth/web-auth.strategy.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { OAuthService } from 'angular-oauth2-oidc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebAuthStrategy } from './web-auth.strategy';

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'RS256' })}.${b64(payload)}.sig`;
}

class FakeOAuth {
  token: string | null = null;
  silentRefresh = vi.fn(async () => undefined);
  logOut = vi.fn();
  initCodeFlow = vi.fn();
  configure = vi.fn();
  setStorage = vi.fn();
  loadDiscoveryDocumentAndTryLogin = vi.fn(async () => true);
  getAccessToken = () => this.token;
}

describe('WebAuthStrategy', () => {
  let oauth: FakeOAuth;
  let strategy: WebAuthStrategy;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T00:00:00Z'));
    oauth = new FakeOAuth();

    TestBed.configureTestingModule({
      providers: [WebAuthStrategy, { provide: OAuthService, useValue: oauth }],
    });

    strategy = TestBed.inject(WebAuthStrategy);
  });

  afterEach(() => vi.useRealTimers());

  it('adopts the token and exposes its claims', async () => {
    oauth.token = jwt({
      preferred_username: 'demo',
      sub: 's',
      permission: ['catalog:write'],
      exp: Math.floor(Date.now() / 1000) + 300,
    });

    await strategy.initialize();

    expect(strategy.user()()?.username).toBe('demo');
    expect(strategy.hasPermission('catalog:write')).toBe(true);
    expect(strategy.hasPermission('orders:write')).toBe(false);
  });

  it('renews at 75% of the token lifetime read from exp, not at a hard-coded interval', async () => {
    oauth.token = jwt({ preferred_username: 'demo', sub: 's', exp: Math.floor(Date.now() / 1000) + 300 });
    await strategy.initialize();

    // 75% of 300s. One tick short, nothing has fired.
    await vi.advanceTimersByTimeAsync(225_000 - 1_000);
    expect(oauth.silentRefresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(oauth.silentRefresh).toHaveBeenCalledOnce();
  });

  it('signs the user out when Keycloak answers login_required', async () => {
    oauth.token = jwt({ preferred_username: 'demo', sub: 's', exp: Math.floor(Date.now() / 1000) + 300 });
    await strategy.initialize();

    oauth.silentRefresh.mockRejectedValueOnce(new Error('login_required'));
    await vi.advanceTimersByTimeAsync(225_000);

    expect(strategy.accessToken()).toBeNull();
    expect(strategy.user()()).toBeNull();
  });

  it('ends the Keycloak session on sign-out, not just the local one', async () => {
    await strategy.signOut();
    expect(oauth.logOut).toHaveBeenCalledOnce();
  });

  it('says the session ends on reload, because the realm issues no refresh token', () => {
    expect(strategy.sessionEndsOnReload).toBe(true);
  });
});
```

- [ ] **Step 12: Run it**

Run: `npm test -- web-auth.strategy`
Expected: PASS, 5 tests.

- [ ] **Step 13: Write the guard and its test**

`src/app/core/auth/permission.guard.ts`:

```ts
import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';

/**
 * The guard hides; the backend decides (spec §4.3). It refuses navigation when
 * the claim is absent, and it carries the permission's name forward so the
 * banner can say which one was needed — the 403 response deliberately does not
 * name one, and the route is the only thing that knows.
 */
export function permissionGuard(permission: string): CanActivateFn {
  return () => {
    const auth = inject(AuthService);
    const router = inject(Router);

    if (auth.hasPermission(permission)) return true;

    return router.createUrlTree(['/tabs/account'], {
      queryParams: { denied: permission },
    });
  };
}
```

`src/app/core/auth/permission.guard.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { Router, UrlTree } from '@angular/router';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';
import { AuthService } from './auth.service';
import { permissionGuard } from './permission.guard';

function guardWith(permissions: readonly string[]): boolean | UrlTree {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: AuthService, useValue: { hasPermission: (n: string) => permissions.includes(n) } },
    ],
  });

  return TestBed.runInInjectionContext(
    () => permissionGuard('catalog:write')(null as never, null as never) as boolean | UrlTree,
  );
}

describe('permissionGuard', () => {
  it('admits a holder of the permission', () => {
    expect(guardWith(['catalog:write'])).toBe(true);
  });

  it('redirects a caller without it, naming the permission that was needed', () => {
    const result = guardWith(['orders:write']);

    expect(result).toBeInstanceOf(UrlTree);
    expect(TestBed.inject(Router).serializeUrl(result as UrlTree)).toContain('denied=catalog:write');
  });
});
```

- [ ] **Step 14: Write the platform factory**

`src/app/core/auth/auth.providers.ts`:

```ts
import { EnvironmentProviders, inject, makeEnvironmentProviders, provideAppInitializer } from '@angular/core';
import { provideOAuthClient } from 'angular-oauth2-oidc';
import { AuthService } from './auth.service';
import { WebAuthStrategy } from './web-auth.strategy';

/**
 * The one place the application asks which platform it is on (spec §4). Every
 * screen, guard and interceptor below this line sees only AuthService.
 *
 * There is no platform test here YET, and its absence is deliberate rather
 * than an oversight: NativeAuthStrategy arrives in plan Task 19, against a
 * `mobile-app` realm client that does not exist either. A branch whose two
 * arms are identical would read as a bug to everyone who met it in between.
 */
export function provideAuth(): EnvironmentProviders {
  return makeEnvironmentProviders([
    provideOAuthClient(),
    WebAuthStrategy,
    { provide: AuthService, useExisting: WebAuthStrategy },
    // The initialiser sees only AuthService — no cast — which is what putting
    // initialize() on the interface buys.
    provideAppInitializer(() => inject(AuthService).initialize()),
  ]);
}
```

- [ ] **Step 15: Run every test and lint**

Run: `npm test && npm run lint`
Expected: all pass.

- [ ] **Step 16: Commit**

```bash
git add src/app/core/auth public/silent-refresh.html
git commit -m "feat(auth): one AuthService interface, web strategy, interceptor and guard"
```

---
## Task 6: API clients

**Files:**
- Create: `src/app/core/api/catalog.api.ts`, `checkout.api.ts`, `ordering.api.ts`
- Test: `src/app/core/api/catalog.api.spec.ts`, `checkout.api.spec.ts`, `ordering.api.spec.ts`

**Interfaces:**
- Consumes: `environment` (Task 2); every type from `types.ts` (Task 3).
- Produces:
  - `CatalogApi.products(cursor: string | null, limit?: number): Observable<CursorPage<ProductSummary>>`
  - `CatalogApi.publish(command: PublishProductCommand): Observable<string>`
  - `CheckoutApi.quote(productIds: readonly string[], currency: string): Observable<QuoteResponse>`
  - `OrderingApi.place(command: PlaceOrderCommand): Observable<string>`
  - `OrderingApi.cancel(orderId: string, reason: CancelReason): Observable<void>`

- [ ] **Step 1: Write the failing catalog test**

`src/app/core/api/catalog.api.spec.ts`:

```ts
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CatalogApi } from './catalog.api';

describe('CatalogApi', () => {
  let api: CatalogApi;
  let controller: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [CatalogApi, provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(CatalogApi);
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => controller.verify());

  it('asks for the first page with limit=20 and no cursor parameter', () => {
    api.products(null).subscribe();

    const request = controller.expectOne(
      (r) => r.url === 'http://localhost:5000/api/v1/catalog/products',
    );

    expect(request.request.method).toBe('GET');
    expect(request.request.params.get('limit')).toBe('20');
    // Absent, not empty: `cursor=` binds as an empty string on the backend and
    // is not the same question as "give me the first page".
    expect(request.request.params.has('cursor')).toBe(false);

    request.flush({ items: [], nextCursor: null });
  });

  it('sends the cursor when one is carried forward', () => {
    api.products('opaque-token').subscribe();

    const request = controller.expectOne(
      (r) => r.url === 'http://localhost:5000/api/v1/catalog/products',
    );

    expect(request.request.params.get('cursor')).toBe('opaque-token');
    request.flush({ items: [], nextCursor: null });
  });

  it('posts a publish command and returns the new product id from a 200', () => {
    const command = {
      commandId: '11111111-1111-1111-1111-111111111111',
      name: 'A thing',
      thumbnailUrl: null,
      amount: 12.5,
      currency: 'EUR',
    };
    const seen = vi.fn();

    api.publish(command).subscribe(seen);

    const request = controller.expectOne('http://localhost:5000/api/v1/catalog/products');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual(command);

    // 200, not 201: ProductEndpoints.cs returns result.ToHttpResult() and
    // ResultExtensions maps a successful Result<Guid> to Results.Ok(value).
    // The body is the bare GUID as a JSON string.
    request.flush('22222222-2222-2222-2222-222222222222', { status: 200, statusText: 'OK' });

    expect(seen).toHaveBeenCalledWith('22222222-2222-2222-2222-222222222222');
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm test -- catalog.api`
Expected: FAIL — cannot resolve `./catalog.api`.

- [ ] **Step 3: Write the catalog client**

`src/app/core/api/catalog.api.ts`:

```ts
import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '@core/config/environment';
import { CursorPage, ProductSummary, PublishProductCommand } from './types';

/**
 * Catalog.Api/Endpoints/ProductEndpoints.cs, through the gateway. The gateway
 * strips /api before forwarding, so the service sees /v1/catalog/products —
 * the path here is the caller's, which is the one this file is responsible for.
 *
 * Knows HTTP and the wire types and nothing about screens (spec §3).
 */
@Injectable({ providedIn: 'root' })
export class CatalogApi {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.gatewayBaseUrl}/api/v1/catalog/products`;

  /**
   * Anonymous — the gateway's `catalog-public` route names YARP's reserved
   * `anonymous` policy and the endpoint itself says AllowAnonymous. This is
   * why the products tab works before sign-in (spec §5.1).
   */
  products(cursor: string | null, limit = 20): Observable<CursorPage<ProductSummary>> {
    let params = new HttpParams().set('limit', limit);
    if (cursor !== null) params = params.set('cursor', cursor);

    return this.http.get<CursorPage<ProductSummary>>(this.base, { params });
  }

  /**
   * Requires `catalog:write`, and requires the gateway's `catalog-write` route
   * (plan Task 0): `catalog-public` matches GET alone, so before that route
   * exists this call 404s at the edge rather than reaching Catalog at all.
   *
   * Replies 200 with the new id, not 201 — there is no Location header to
   * follow, and no endpoint to follow it to.
   */
  publish(command: PublishProductCommand): Observable<string> {
    return this.http.post<string>(this.base, command);
  }
}
```

- [ ] **Step 4: Run it**

Run: `npm test -- catalog.api`
Expected: PASS, 3 tests.

- [ ] **Step 5: Write the failing checkout test**

`src/app/core/api/checkout.api.spec.ts`:

```ts
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CheckoutApi } from './checkout.api';

describe('CheckoutApi', () => {
  let api: CheckoutApi;
  let controller: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [CheckoutApi, provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(CheckoutApi);
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => controller.verify());

  it('repeats productId once per product and sends one currency', () => {
    api.quote(['p1', 'p2', 'p3'], 'EUR').subscribe();

    const request = controller.expectOne(
      (r) => r.url === 'http://localhost:5000/bff/v1/checkout/quote',
    );

    // Guid[] binds from repeated parameters, not from a comma-joined list:
    // "p1,p2" would bind as one malformed Guid and answer 400.
    expect(request.request.params.getAll('productId')).toEqual(['p1', 'p2', 'p3']);
    expect(request.request.params.get('currency')).toBe('EUR');

    request.flush({ currency: 'EUR', lines: [], total: 0, unpriced: [] });
  });

  it('sends each distinct product once', () => {
    // The BFF deduplicates anyway, but spending the request on the same id
    // twice spends the caller's rate-limit budget on nothing.
    api.quote(['p1', 'p1', 'p2'], 'EUR').subscribe();

    const request = controller.expectOne(
      (r) => r.url === 'http://localhost:5000/bff/v1/checkout/quote',
    );

    expect(request.request.params.getAll('productId')).toEqual(['p1', 'p2']);
    request.flush({ currency: 'EUR', lines: [], total: 0, unpriced: [] });
  });

  it('uses the /bff namespace, not /api', () => {
    api.quote(['p1'], 'GBP').subscribe();

    const request = controller.expectOne((r) => r.url.includes('/bff/'));
    expect(request.request.url).toBe('http://localhost:5000/bff/v1/checkout/quote');
    request.flush({ currency: 'GBP', lines: [], total: 0, unpriced: [] });
  });
});
```

- [ ] **Step 6: Run, watch it fail, then write the checkout client**

Run: `npm test -- checkout.api` → FAIL.

`src/app/core/api/checkout.api.ts`:

```ts
import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '@core/config/environment';
import { QuoteResponse } from './types';

/**
 * Web.Bff/Endpoints/CheckoutEndpoints.cs, through the gateway's second
 * namespace. /bff rather than /api because a client picks one or the other:
 * aggregated responses shaped for a screen, or the service APIs shaped for a
 * resource. The gateway strips /bff exactly as it strips /api.
 */
@Injectable({ providedIn: 'root' })
export class CheckoutApi {
  private readonly http = inject(HttpClient);
  private readonly url = `${environment.gatewayBaseUrl}/bff/v1/checkout/quote`;

  /** Authenticated at the edge and again at the BFF's route group. */
  quote(productIds: readonly string[], currency: string): Observable<QuoteResponse> {
    let params = new HttpParams().set('currency', currency);

    for (const id of new Set(productIds)) params = params.append('productId', id);

    return this.http.get<QuoteResponse>(this.url, { params });
  }
}
```

Run: `npm test -- checkout.api`
Expected: PASS, 3 tests.

- [ ] **Step 7: Write the failing ordering test**

`src/app/core/api/ordering.api.spec.ts`:

```ts
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderingApi } from './ordering.api';
import { PlaceOrderCommand } from './types';

describe('OrderingApi', () => {
  let api: OrderingApi;
  let controller: HttpTestingController;

  const command: PlaceOrderCommand = {
    commandId: '11111111-1111-1111-1111-111111111111',
    items: [{ productId: 'p1', quantity: 2 }],
    shippingAddress: {
      line1: '1 Example Street',
      line2: null,
      city: 'Doha',
      postalCode: '00000',
      country: 'QA',
    },
    currency: 'EUR',
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [OrderingApi, provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(OrderingApi);
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => controller.verify());

  it('posts the command verbatim and returns the order id from a 200', () => {
    const seen = vi.fn();
    api.place(command).subscribe(seen);

    const request = controller.expectOne('http://localhost:5000/api/v1/orders');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual(command);

    request.flush('33333333-3333-3333-3333-333333333333', { status: 200, statusText: 'OK' });
    expect(seen).toHaveBeenCalledWith('33333333-3333-3333-3333-333333333333');
  });

  it('sends no customerId — the subject is bound from the principal', () => {
    api.place(command).subscribe();

    const request = controller.expectOne('http://localhost:5000/api/v1/orders');

    // Exactly four keys. A customerId here would be a field any authenticated
    // caller sets to somebody else's GUID; PlaceOrderCommand omits it on
    // purpose and the client must not offer one back.
    expect(Object.keys(request.request.body)).toEqual([
      'commandId', 'items', 'shippingAddress', 'currency',
    ]);

    request.flush('33333333-3333-3333-3333-333333333333', { status: 200, statusText: 'OK' });
  });

  it('cancels with the reason in the body and accepts a 204', () => {
    const done = vi.fn();
    api.cancel('33333333-3333-3333-3333-333333333333', 'customer_request').subscribe({ complete: done });

    const request = controller.expectOne(
      'http://localhost:5000/api/v1/orders/33333333-3333-3333-3333-333333333333/cancel',
    );

    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ reason: 'customer_request' });

    request.flush(null, { status: 204, statusText: 'No Content' });
    expect(done).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 8: Run, watch it fail, then write the ordering client**

Run: `npm test -- ordering.api` → FAIL.

`src/app/core/api/ordering.api.ts`:

```ts
import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '@core/config/environment';
import { CancelOrderRequest, CancelReason, PlaceOrderCommand } from './types';

/**
 * Ordering.Api/Endpoints/OrderEndpoints.cs, through the gateway.
 *
 * There is no read here, and the omission is the platform's rather than this
 * file's: Ordering exposes no endpoint that reads an order back, and
 * OrderingPermissions.cs says why there is no `orders:read` to require. The
 * order-placed screen states the consequence instead of inventing a status
 * (spec §5.4).
 */
@Injectable({ providedIn: 'root' })
export class OrderingApi {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.gatewayBaseUrl}/api/v1/orders`;

  /** Requires `orders:write`. Replies 200 with the new order's id. */
  place(command: PlaceOrderCommand): Observable<string> {
    return this.http.post<string>(this.base, command);
  }

  /**
   * Requires `orders:cancel`. Replies 204. An unknown reason code would be a
   * 400 keyed `Reason` — the backend refuses a code it does not know rather
   * than defaulting, so CANCEL_REASONS is the whole vocabulary and the select
   * is bound to it.
   */
  cancel(orderId: string, reason: CancelReason): Observable<void> {
    const body: CancelOrderRequest = { reason };

    return this.http.post<void>(`${this.base}/${orderId}/cancel`, body);
  }
}
```

Run: `npm test -- ordering.api`
Expected: PASS, 3 tests.

- [ ] **Step 9: Commit**

```bash
git add src/app/core/api
git commit -m "feat(api): catalog, checkout and ordering clients with exact wire assertions"
```

---

## Task 7: Cart store and persistence

**Files:**
- Create: `src/app/core/cart/cart.store.ts`, `src/app/core/cart/cart.persistence.ts`
- Test: `src/app/core/cart/cart.store.spec.ts`

**Interfaces:**
- Consumes: `ProductSummary` (Task 3).
- Produces:
  - `interface CartLine { productId: string; name: string; amount: number; currency: string; quantity: number }`
  - `CartStore.lines: Signal<readonly CartLine[]>`, `.count: Signal<number>`, `.isEmpty: Signal<boolean>`, `.productIds: Signal<readonly string[]>`
  - `CartStore.add(product: ProductSummary): void`, `.setQuantity(productId: string, quantity: number): void`, `.remove(productId: string): void`, `.clear(): void`, `.restore(): Promise<void>`
  - `CartPersistence.read(): Promise<readonly CartLine[]>`, `.write(lines: readonly CartLine[]): Promise<void>`

- [ ] **Step 1: Install Capacitor's core and Preferences**

`cart.persistence.ts` imports `@capacitor/preferences`, so it arrives here —
NOT in Task 18. Task 18 adds the native platforms and the plugins only a native
shell needs; Preferences is used by the web build too, because on the web it is
`localStorage` behind the same interface. Deferring it to Task 18 would leave
Tasks 7 through 17 unable to build.

```bash
npm install --save-exact @capacitor/core@8.5.1 @capacitor/preferences@8.0.1
```

`--save-exact` for the same reason as everywhere else. Task 18 installs
`@capacitor/cli`, `@capacitor/android`, `@capacitor/ios`, `@capacitor/app` and
`@capacitor/browser` on top of these two and must not reinstall or re-pin them.

- [ ] **Step 2: Write the failing store test**

`src/app/core/cart/cart.store.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProductSummary } from '@core/api/types';
import { CartPersistence } from './cart.persistence';
import { CartStore } from './cart.store';

const product = (id: string, name = 'Thing', amount = 10): ProductSummary => ({
  productId: id,
  name,
  thumbnailUrl: null,
  amount,
  currency: 'EUR',
  publishedAt: '2026-09-10T00:00:00Z',
});

describe('CartStore', () => {
  let store: CartStore;
  let write: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    write = vi.fn(async () => undefined);
    TestBed.configureTestingModule({
      providers: [
        CartStore,
        { provide: CartPersistence, useValue: { read: async () => [], write } },
      ],
    });
    store = TestBed.inject(CartStore);
  });

  it('starts empty', () => {
    expect(store.isEmpty()).toBe(true);
    expect(store.count()).toBe(0);
  });

  it('adds a product as a line of quantity one', () => {
    store.add(product('p1', 'Widget', 12.5));

    expect(store.lines()).toEqual([
      { productId: 'p1', name: 'Widget', amount: 12.5, currency: 'EUR', quantity: 1 },
    ]);
  });

  it('adding the same product again raises the quantity rather than duplicating the line', () => {
    store.add(product('p1'));
    store.add(product('p1'));

    expect(store.lines()).toHaveLength(1);
    expect(store.lines()[0].quantity).toBe(2);
    expect(store.count()).toBe(2);
  });

  it('setting a quantity of zero removes the line', () => {
    store.add(product('p1'));
    store.setQuantity('p1', 0);

    expect(store.lines()).toEqual([]);
  });

  it('refuses a negative quantity', () => {
    store.add(product('p1'));
    store.setQuantity('p1', -3);

    expect(store.lines()).toEqual([]);
  });

  it('does not persist the state it was born with', () => {
    // The effect is scheduled at construction and its first flush can land
    // while restore() is still awaiting the read. Persisting there writes []
    // over the stored cart: the screen is then right and storage is empty, so
    // the cart survives one reload and vanishes on the second.
    TestBed.tick();

    expect(persistence.write).not.toHaveBeenCalled();
  });

  it('persists a cart the user emptied, which is not the same thing', async () => {
    store.add(product('p1'));
    TestBed.tick();
    store.clear();
    TestBed.tick();

    // clear() sets a fresh [], a different object from INITIAL, so it writes.
    expect(persistence.write).toHaveBeenLastCalledWith([]);
  });

  it('persists on every change', async () => {
    store.add(product('p1'));
    // TestBed.tick() — NOT `await Promise.resolve()`. The scheduler uses
    // scheduleCallbackWithRafRace, so a bare microtask does not reliably
    // flush and the test would pass or fail on timing luck.
    TestBed.tick();

    expect(write).toHaveBeenCalledWith([
      { productId: 'p1', name: 'Thing', amount: 10, currency: 'EUR', quantity: 1 },
    ]);
  });

  it('restores what was persisted', async () => {
    const stored = [{ productId: 'p9', name: 'Restored', amount: 3, currency: 'GBP', quantity: 4 }];
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        CartStore,
        { provide: CartPersistence, useValue: { read: async () => stored, write } },
      ],
    });

    const restored = TestBed.inject(CartStore);
    await restored.restore();

    expect(restored.lines()).toEqual(stored);
    expect(restored.count()).toBe(4);
  });

  it('clear empties the cart and persists the emptiness', async () => {
    store.add(product('p1'));
    store.clear();
    TestBed.tick();

    expect(store.lines()).toEqual([]);
    expect(write).toHaveBeenLastCalledWith([]);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm test -- cart.store`
Expected: FAIL — cannot resolve `./cart.persistence`.

- [ ] **Step 3: Write the persistence adapter**

`src/app/core/cart/cart.persistence.ts`:

```ts
import { Injectable } from '@angular/core';
import { Preferences } from '@capacitor/preferences';
import { CartLine } from './cart.store';

/**
 * Capacitor Preferences on every platform, which on the web is localStorage
 * behind the same interface. The cart is not a secret and not a credential —
 * that distinction is why the refresh token goes to secure storage (spec §4.2)
 * and this does not.
 */
@Injectable({ providedIn: 'root' })
export class CartPersistence {
  private static readonly KEY = 'blueprint.cart';

  async read(): Promise<readonly CartLine[]> {
    const { value } = await Preferences.get({ key: CartPersistence.KEY });
    if (!value) return [];

    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as CartLine[]) : [];
    } catch {
      // A corrupt entry is an empty cart, not a crash on startup. Losing a
      // cart is recoverable; a shell that will not boot is not.
      return [];
    }
  }

  async write(lines: readonly CartLine[]): Promise<void> {
    await Preferences.set({ key: CartPersistence.KEY, value: JSON.stringify(lines) });
  }
}
```

- [ ] **Step 4: Write the store**

`src/app/core/cart/cart.store.ts`:

```ts
import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { ProductSummary } from '@core/api/types';
import { CartPersistence } from './cart.persistence';

/**
 * The backend has no cart, so the cart is client state (spec §3). `amount` is
 * the LISTING price, and the cart labels it as such: the quote is the price
 * that counts, and it comes from the BFF.
 */
export interface CartLine {
  readonly productId: string;
  readonly name: string;
  readonly amount: number;
  readonly currency: string;
  readonly quantity: number;
}

/**
 * In core rather than in a feature, because two features share it — the
 * products page writes and the cart and checkout pages read. That sharing is
 * the whole reason spec §3 puts it here instead of under features/cart.
 */
@Injectable({ providedIn: 'root' })
export class CartStore {
  private readonly persistence = inject(CartPersistence);
  /**
   * The array the signal starts at, held as a named constant so its IDENTITY
   * can be recognised later. This is what tells "not yet read from storage"
   * apart from "emptied by the user": clear() sets a FRESH [], a different
   * object, so a genuinely emptied cart still persists while this one never
   * does. Without the distinction the two are indistinguishable, because
   * both are an empty array.
   */
  private static readonly INITIAL: readonly CartLine[] = [];

  private readonly state = signal<readonly CartLine[]>(CartStore.INITIAL);

  /**
   * The exact array reference `restore()` last wrote, or null.
   *
   * NOT a boolean. A `restoring = true / finally restoring = false` flag is
   * structurally a no-op here: effects are SCHEDULED under zoneless change
   * detection, never run inside the signal write, and `restore()`'s finally
   * block runs synchronously in the same call stack as `state.set()` — so the
   * flag is always back to false before any flush can read it, and `restore()`
   * writes back exactly what it just read.
   *
   * Comparing references works because a genuine mutation afterwards replaces
   * the array with a DIFFERENT one, so it still persists. Suppressing by
   * staleness instead would swallow that write, which is the worse bug and a
   * silent one.
   */
  private pendingRestore: readonly CartLine[] | null = null;

  readonly lines = this.state.asReadonly();
  readonly count = computed(() => this.state().reduce((total, line) => total + line.quantity, 0));
  readonly isEmpty = computed(() => this.state().length === 0);
  readonly productIds = computed(() => this.state().map((line) => line.productId));

  constructor() {
    effect(() => {
      const lines = this.state();

      // Never persist the state the signal was BORN with. This effect is
      // scheduled at construction, and its first flush can land while
      // restore() is still awaiting persistence.read() - at which point
      // state() is this initial [] and pendingRestore is still null, so the
      // echo guard below does not fire and the effect writes [] straight
      // over the stored cart. restore() then sets the real lines, so the
      // SCREEN is correct and storage is empty: the cart survives one
      // reload and vanishes on the second. Returning the promise from
      // provideAppInitializer does not prevent this - blocking bootstrap on
      // the initializer does not stop the zoneless effect scheduler from
      // flushing during the await. Observed, not theorised.
      if (lines === CartStore.INITIAL) return;

      // Skip only the write for the restore that produced THIS exact array.
      // Anything else — including a change made after the restore but before
      // this effect flushed — is a real change and must persist.
      if (lines === this.pendingRestore) {
        this.pendingRestore = null;
        return;
      }

      void this.persistence.write(lines);
    });
  }

  async restore(): Promise<void> {
    const restored = await this.persistence.read();

    this.pendingRestore = restored;
    this.state.set(restored);
  }

  add(product: ProductSummary): void {
    this.state.update((lines) => {
      const existing = lines.find((line) => line.productId === product.productId);

      return existing
        ? lines.map((line) =>
            line.productId === product.productId ? { ...line, quantity: line.quantity + 1 } : line,
          )
        : [
            ...lines,
            {
              productId: product.productId,
              name: product.name,
              amount: product.amount,
              currency: product.currency,
              quantity: 1,
            },
          ];
    });
  }

  setQuantity(productId: string, quantity: number): void {
    // Zero and negative both remove. A stepper that can reach zero is the
    // ordinary way a line is deleted, and PlaceOrderItem has no meaning at a
    // quantity of nought.
    this.state.update((lines) =>
      quantity <= 0
        ? lines.filter((line) => line.productId !== productId)
        : lines.map((line) => (line.productId === productId ? { ...line, quantity } : line)),
    );
  }

  remove(productId: string): void {
    this.setQuantity(productId, 0);
  }

  clear(): void {
    this.state.set([]);
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `npm test -- cart.store`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add src/app/core/cart
git commit -m "feat(cart): signals store persisted through Capacitor Preferences"
```

---

## Task 8: The command-id lifecycle

Spec §5.3 is the one place the client holds state across requests on purpose. It is a state machine, so it is built and tested as one, separately from any page.

**Files:**
- Create: `src/app/core/commands/command-id.ts`
- Test: `src/app/core/commands/command-id.spec.ts`

**Interfaces:**
- Consumes: `DisplayError` (Task 4).
- Produces: `class CommandIdentity { readonly current: Signal<string>; readonly isSpent: Signal<boolean>; onFailure(error: DisplayError): void; onEdit(): void; onSuccess(): void; }` and `const ALREADY_COMMITTED = 'already-committed'` (the sentinel order id, here rather than on a page so two features can share it).

- [ ] **Step 1: Write the failing state-machine test**

`src/app/core/commands/command-id.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DisplayError, ErrorKind } from '@core/errors/error-mapper';
import { CommandIdentity } from './command-id';

const failure = (kind: ErrorKind): DisplayError => ({ kind, title: '', detail: null });

describe('CommandIdentity', () => {
  it('mints an id when the form is entered', () => {
    // Pins the v4 version nibble and the RFC 4122 variant nibble, not merely
    // the 8-4-4-4-12 grouping — which a v1 UUID, or any correctly grouped
    // random hex, would also satisfy.
    expect(new CommandIdentity().current()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('keeps the id across a network failure, so the retry is a replay', () => {
    const identity = new CommandIdentity();
    const first = identity.current();

    identity.onFailure(failure('retry'));

    expect(identity.current()).toBe(first);
  });

  it('keeps the id across an unavailable service', () => {
    const identity = new CommandIdentity();
    const first = identity.current();

    identity.onFailure(failure('unavailable'));

    expect(identity.current()).toBe(first);
  });

  it('keeps the id when an identical request is still in flight', () => {
    // request.in_progress means the FIRST attempt is still running. A new id
    // would turn the retry into a second order.
    const identity = new CommandIdentity();
    const first = identity.current();

    identity.onFailure(failure('inProgress'));

    expect(identity.current()).toBe(first);
  });

  it('mints a new id after a success', () => {
    const identity = new CommandIdentity();
    const first = identity.current();

    identity.onSuccess();

    expect(identity.current()).not.toBe(first);
  });

  it('mints a new id when the form is edited after a validation failure', () => {
    const identity = new CommandIdentity();
    const first = identity.current();

    identity.onFailure(failure('validation'));
    expect(identity.current()).toBe(first);

    identity.onEdit();
    expect(identity.current()).not.toBe(first);
  });

  it('does not mint a new id on an edit that follows no failure', () => {
    // Typing in a form that has never been submitted must not churn the id:
    // the id identifies the SUBMISSION, and there has not been one.
    const identity = new CommandIdentity();
    const first = identity.current();

    identity.onEdit();

    expect(identity.current()).toBe(first);
  });

  it('does not mint a new id on an edit after a non-validation failure', () => {
    // The submission may have committed. Editing and resubmitting under a new
    // id is exactly the duplicate order IdempotencyBehavior exists to prevent,
    // so an edit here does NOT release the id.
    const identity = new CommandIdentity();
    const first = identity.current();

    identity.onFailure(failure('retry'));
    identity.onEdit();

    expect(identity.current()).toBe(first);
  });

  it('keeps the id after an already-committed answer, and never resubmits it', () => {
    const identity = new CommandIdentity();
    const first = identity.current();

    identity.onFailure(failure('alreadyCommitted'));

    expect(identity.current()).toBe(first);
    expect(identity.isSpent()).toBe(true);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm test -- command-id`
Expected: FAIL — cannot resolve `./command-id`.

- [ ] **Step 3: Write the state machine**

`src/app/core/commands/command-id.ts`:

```ts
import { Signal, signal } from '@angular/core';
import { DisplayError } from '@core/errors/error-mapper';

/**
 * Spec §5.3's command-id lifecycle, as a state machine rather than as three
 * lines scattered through a page.
 *
 * The backend keys IdempotencyBehavior on subject, operation and commandId. A
 * retry with the same id is a replay; a concurrent second request with the
 * same id is refused with 409 `request.in_progress`; a retry of an id whose
 * result has expired is 409 `command.already_committed`. So the id is minted
 * once per FORM, not once per click — and the difference between the two is
 * the difference between a replay and a second order.
 */
/**
 * The order id the placed page is given when the platform answered
 * `command.already_committed`: the order exists, but no id came back and there
 * is no endpoint to read one from. It lives here rather than on the checkout
 * page because two features need it and a feature never imports another
 * feature (spec §3) — the ESLint rule and the boundary test both enforce that.
 */
export const ALREADY_COMMITTED = 'already-committed';

export class CommandIdentity {
  private readonly id = signal(crypto.randomUUID());
  private readonly spent = signal(false);
  private failedValidationOnly = false;

  readonly current: Signal<string> = this.id.asReadonly();

  /**
   * True once the platform has said this id already committed.
   *
   * This is a RECORD of the fact, not an enforcement of it. `current` keeps
   * returning a usable id, and nothing here refuses to hand it out — a page
   * holding a spent identity must read this and disable its own submit. The
   * class cannot do it for them without making `current()` throw, which would
   * move the failure somewhere far worse than a disabled button.
   */
  readonly isSpent: Signal<boolean> = this.spent.asReadonly();

  onFailure(error: DisplayError): void {
    // A validation failure never reached a handler — the request was refused
    // before IdempotencyBehavior claimed anything — so the id is free to be
    // released once the user changes the form. Every other failure may have
    // committed, so the id is held.
    this.failedValidationOnly = error.kind === 'validation';

    if (error.kind === 'alreadyCommitted') this.spent.set(true);
  }

  /**
   * An edit releases the id ONLY after a validation failure. After a network
   * failure or a 5xx the submission may have committed, and resubmitting
   * changed data under a fresh id is the duplicate the whole mechanism exists
   * to prevent.
   */
  onEdit(): void {
    // Spent is sticky, and this guard is why. onFailure() records the LATEST
    // kind only, so `alreadyCommitted` followed by `validation` leaves the id
    // spent while setting the validation flag — and without this line the next
    // edit would mint, handing back a live id for a command the platform has
    // already applied. That is a second order. Only onSuccess() clears spent,
    // because only a completed submission legitimately begins a new one.
    if (this.spent()) return;

    if (!this.failedValidationOnly) return;

    this.mint();
  }

  onSuccess(): void {
    this.mint();
  }

  private mint(): void {
    this.id.set(crypto.randomUUID());
    this.spent.set(false);
    this.failedValidationOnly = false;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- command-id`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/core/commands
git commit -m "feat(commands): command-id lifecycle as a tested state machine"
```

---

## Task 9: Shell, tabs and routing

**Files:**
- Create: `src/app/tabs/tabs.page.ts`
- Modify: `src/app/app.ts` (**not** `app.component.ts` — Angular 22 scaffolds suffix-less: `app.ts`, `app.html`, `app.spec.ts`), `src/app/app.routes.ts`, `src/app/app.config.ts`, `src/main.ts`
- Test: `src/app/tabs/tabs.page.spec.ts`

**Interfaces:**
- Consumes: `AuthService`, `permissionGuard`, `provideAuth` (Task 5); `CartStore` (Task 7); `PERMISSIONS` (Task 3).
- Produces: routes `/tabs/products`, `/tabs/cart`, `/tabs/cart/checkout`, `/tabs/cart/placed/:id`, `/tabs/publish`, `/tabs/account`.

- [ ] **Step 1: Write the failing tabs test**

`src/app/tabs/tabs.page.spec.ts`:

```ts
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from '@core/auth/auth.service';
import { TabsPage } from './tabs.page';

function mount(permissions: readonly string[]): ComponentFixture<TabsPage> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [TabsPage],
    providers: [
      provideRouter([]),
      {
        provide: AuthService,
        useValue: {
          hasPermission: (n: string) => permissions.includes(n),
          user: () => signal(null),
        },
      },
    ],
  });

  const fixture = TestBed.createComponent(TabsPage);
  fixture.detectChanges();
  return fixture;
}

describe('TabsPage', () => {
  it('shows three tabs to a user holding no permissions', () => {
    const tabs = mount([]).nativeElement.querySelectorAll('ion-tab-button');

    expect([...tabs].map((t: Element) => t.getAttribute('tab'))).toEqual([
      'products',
      'cart',
      'account',
    ]);
  });

  it('adds the publish tab for a holder of catalog:write', () => {
    const tabs = mount(['catalog:write']).nativeElement.querySelectorAll('ion-tab-button');

    expect([...tabs].map((t: Element) => t.getAttribute('tab'))).toEqual([
      'products',
      'cart',
      'publish',
      'account',
    ]);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm test -- tabs.page`
Expected: FAIL — cannot resolve `./tabs.page`.

- [ ] **Step 3: Write the tabs shell**

`src/app/tabs/tabs.page.ts`:

```ts
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { IonBadge, IonIcon, IonLabel, IonTabBar, IonTabButton, IonTabs } from '@ionic/angular';
import { PERMISSIONS } from '@core/api/types';
import { AuthService } from '@core/auth/auth.service';
import { CartStore } from '@core/cart/cart.store';

/**
 * Spec §5: Products, Cart, Account, plus Publish as a fourth tab that appears
 * only when catalog:write is held. The tab HIDES; the guard on the route
 * refuses; the backend decides. All three, because a hidden button and a
 * refused call are two different facts (spec §4.3).
 */
@Component({
  selector: 'app-tabs',
  standalone: true,
  imports: [IonBadge, IonIcon, IonLabel, IonTabBar, IonTabButton, IonTabs],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ion-tabs>
      <ion-tab-bar slot="bottom">
        <ion-tab-button tab="products">
          <ion-icon name="grid-outline"></ion-icon>
          <ion-label>Products</ion-label>
        </ion-tab-button>

        <ion-tab-button tab="cart">
          <ion-icon name="cart-outline"></ion-icon>
          <ion-label>Cart</ion-label>
          @if (cartCount() > 0) {
            <ion-badge>{{ cartCount() }}</ion-badge>
          }
        </ion-tab-button>

        @if (canPublish()) {
          <ion-tab-button tab="publish">
            <ion-icon name="cloud-upload-outline"></ion-icon>
            <ion-label>Publish</ion-label>
          </ion-tab-button>
        }

        <ion-tab-button tab="account">
          <ion-icon name="person-outline"></ion-icon>
          <ion-label>Account</ion-label>
        </ion-tab-button>
      </ion-tab-bar>
    </ion-tabs>
  `,
})
export class TabsPage {
  private readonly auth = inject(AuthService);
  private readonly cart = inject(CartStore);

  protected readonly cartCount = this.cart.count;
  protected readonly canPublish = computed(() => this.auth.hasPermission(PERMISSIONS.catalogWrite));
}
```

- [ ] **Step 4: Write the routes**

`src/app/app.routes.ts`:

```ts
import { Routes } from '@angular/router';
import { PERMISSIONS } from '@core/api/types';
import { permissionGuard } from '@core/auth/permission.guard';

/**
 * Checkout and Order placed are pushed onto the Cart tab's stack (spec §5), so
 * they are children of the cart route rather than tabs of their own — the back
 * button then returns to the cart, which is where the user came from.
 */
export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'tabs/products' },
  {
    path: 'tabs',
    loadComponent: () => import('./tabs/tabs.page').then((m) => m.TabsPage),
    children: [
      {
        path: 'products',
        loadComponent: () => import('@features/products/products.page').then((m) => m.ProductsPage),
      },
      {
        path: 'cart',
        loadComponent: () => import('@features/cart/cart.page').then((m) => m.CartPage),
      },
      {
        path: 'cart/checkout',
        loadComponent: () => import('@features/checkout/checkout.page').then((m) => m.CheckoutPage),
      },
      {
        path: 'cart/placed/:id',
        loadComponent: () =>
          import('@features/order-placed/order-placed.page').then((m) => m.OrderPlacedPage),
      },
      {
        path: 'publish',
        // The guard refuses a direct navigation even though the tab is hidden.
        // The e2e smoke asserts both halves for the `browser` user (spec §7).
        canActivate: [permissionGuard(PERMISSIONS.catalogWrite)],
        loadComponent: () => import('@features/publish/publish.page').then((m) => m.PublishPage),
      },
      {
        path: 'account',
        loadComponent: () => import('@features/account/account.page').then((m) => m.AccountPage),
      },
      { path: '', pathMatch: 'full', redirectTo: 'products' },
    ],
  },
];
```

- [ ] **Step 5: Wire the application config**

`src/app/app.config.ts`:

```ts
import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
  inject,
  provideAppInitializer,
} from '@angular/core';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideRouter, RouteReuseStrategy } from '@angular/router';
import { IonicRouteStrategy, provideIonicAngular } from '@ionic/angular';
import { routes } from './app.routes';
import { authInterceptor } from '@core/auth/auth.interceptor';
import { provideAuth } from '@core/auth/auth.providers';
import { CartStore } from '@core/cart/cart.store';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    // Funnels window.onerror / unhandledrejection into Angular's
    // ErrorHandler. Present in the CLI scaffold's original app.config.ts;
    // Task 9's brief omitted it from its app.config.ts snippet without
    // recording that as deliberate, so it is restored here rather than
    // treated as superseded.
    provideBrowserGlobalErrorListeners(),
    provideIonicAngular(),
    // Angular's default RouteReuseStrategy compares only `routeConfig`
    // identity, ignoring params — so `placed/:id` navigating A -> B keeps
    // the SAME ActivatedRoute and component instance, and a page that reads
    // `route.snapshot` once (rather than subscribing to `paramMap`) shows
    // stale data forever after. IonicRouteStrategy is Ionic's own fix for
    // exactly this (it compares params too); provideIonicAngular() does not
    // install it, so it must be provided here. Task 13's review caught the
    // absence via order-placed.page.ts; this line is the app-wide fix, not
    // a page-local workaround.
    { provide: RouteReuseStrategy, useClass: IonicRouteStrategy },
    provideRouter(routes),
    provideHttpClient(withInterceptors([authInterceptor])),
    provideAuth(),
    // The cart survives a restart on every platform (spec §3). Restoring it
    // before the first render keeps the tab badge from flashing zero.
    //
    // RETURN the promise — do not fire and forget. Angular waits on a
    // returned promise before bootstrapping, so the first render sees the
    // restored cart instead of one that starts at zero and jumps a moment
    // later. That is the actual reason to return it here.
    //
    // It does NOT, on its own, close the race with CartStore's persistence
    // effect. That effect is scheduled once at construction, not run
    // synchronously, so under zoneless change detection its first flush can
    // land while `restore()` below is still awaiting `persistence.read()` —
    // Angular blocking bootstrap on this initializer's promise does not stop
    // the effect scheduler from flushing during that await, because the
    // scheduler is not gated on bootstrap at all. A flush that lands there
    // would see the signal still holding the exact array it was constructed
    // with and, without a guard against that, would persist `[]` over
    // whatever the real cart was — silently, since the in-memory state gets
    // corrected a moment later when `restore()` resolves and the screen ends
    // up right even though storage does not. That race is closed inside
    // CartStore itself, by refusing to ever persist the array the store was
    // born with (see `CartStore.INITIAL`), not by anything here.
    provideAppInitializer(() => inject(CartStore).restore()),
  ],
};
```

- [ ] **Step 6: Create placeholder page components so the routes resolve**

Each of the six feature pages gets a minimal standalone component now, replaced in Tasks 10–15. For example `src/app/features/products/products.page.ts`:

```ts
import { Component } from '@angular/core';
import { IonContent, IonHeader, IonTitle, IonToolbar } from '@ionic/angular';

@Component({
  selector: 'app-products',
  standalone: true,
  imports: [IonContent, IonHeader, IonTitle, IonToolbar],
  template: `
    <ion-header><ion-toolbar><ion-title>Products</ion-title></ion-toolbar></ion-header>
    <ion-content></ion-content>
  `,
})
export class ProductsPage {
  private readonly catalog = inject(CatalogApi);
  private readonly cart = inject(CartStore);
  private cursor: string | null = null;

  /**
   * Bumped by `reload()`. `load()` captures the generation it was called
   * under and checks it again when the response lands; a response whose
   * generation no longer matches was superseded by a later `reload()` and is
   * dropped rather than applied. Without this, a `loadMore()` in flight when
   * Task 14's publish page calls `reload()` lands AFTER the fresh first page
   * and appends its items onto — and overwrites `cursor` from — a pagination
   * sequence that `reload()` already discarded. A `switchMap` would hide that
   * drop rather than state it, and `load()` is called from three call sites
   * (constructor, `reload()`, `loadMore()`) with different completion
   * semantics that a shared pipeline operator would have to paper over.
   */
  private generation = 0;

  private readonly productsSignal = signal<readonly ProductSummary[]>([]);
  private readonly errorSignal = signal<DisplayError | null>(null);
  /** Null nextCursor is the last page (CursorPage.cs). Nothing asks past it. */
  private readonly hasMoreSignal = signal(true);

  // Writable only inside this class — CartStore.lines and CommandIdentity's
  // current/isSpent make the same choice, for the same reason: Task 14 holds
  // a reference to this instance and `readonly` on the field only stops
  // reassignment, not `.set()` from outside.
  readonly products: Signal<readonly ProductSummary[]> = this.productsSignal.asReadonly();
  readonly error: Signal<DisplayError | null> = this.errorSignal.asReadonly();
  readonly hasMore: Signal<boolean> = this.hasMoreSignal.asReadonly();

  constructor() {
    this.load();
  }

  /** Called by the publish page after a success (spec §5.5). */
  reload(): void {
    this.generation++;
    this.cursor = null;
    this.productsSignal.set([]);
    this.hasMoreSignal.set(true);
    this.load();
  }

  loadMore(event?: { target: { complete: () => void } }): void {
    this.load(() => event?.target.complete());
  }

  addToCart(product: ProductSummary): void {
    // Local only. The backend has no cart, so there is nothing to call.
    this.cart.add(product);
  }

  private load(done?: () => void): void {
    const generation = this.generation;

    this.catalog.products(this.cursor).subscribe({
      next: (page) => {
        // The ion-infinite-scroll element that triggered this call (if any)
        // is not destroyed by reload() — only the signals are reset — so its
        // internal `isLoading` flag survives a reload and must still be
        // cleared here even when the response itself is discarded below.
        // Ionic's own InfiniteScroll never fires `ionInfinite` again while
        // `isLoading` stays true, so skipping this on the stale branch would
        // reintroduce the hang this component exists to avoid.
        done?.();

        // Superseded by a reload() that started a new pagination sequence
        // while this request was in flight. Applying it now would append
        // onto the fresh list and overwrite `cursor` with a value computed
        // against the sequence reload() already discarded.
        if (generation !== this.generation) return;

        this.errorSignal.set(null);
        this.productsSignal.update((existing) => [...existing, ...page.items]);
        this.cursor = page.nextCursor;
        this.hasMoreSignal.set(page.nextCursor !== null);
      },
      error: (failure: HttpErrorResponse) => {
        done?.();
        if (generation !== this.generation) return;

        this.errorSignal.set(mapError(failure));
        // Stop asking. Retrying into a 429 is how a rate limit becomes a loop.
        this.hasMoreSignal.set(false);
      },
    });
  }
}
```

Repeat with `CartPage`, `CheckoutPage`, `OrderPlacedPage`, `PublishPage`, `AccountPage` in their own folders, changing the selector, class name and title each time.

- [ ] **Step 7: Run everything**

Run: `npm test && npm run lint && npm run build`
Expected: all pass, including the two tabs tests.

- [ ] **Step 8: Commit**

```bash
git add src/app/tabs src/app/app.routes.ts src/app/app.config.ts src/app/features
git commit -m "feat(shell): tabs, routes and the permission-gated publish tab"
```

---
## Task 10: Products page

**Files:**
- Modify: `src/app/features/products/products.page.ts` (replaces the Task 9 placeholder)
- Test: `src/app/features/products/products.page.spec.ts`

**Interfaces:**
- Consumes: `CatalogApi.products` (Task 6), `CartStore.add` (Task 7), `mapError` (Task 4), `ErrorBannerComponent` (Task 4).
- Produces: `ProductsPage` with a public `reload(): void` that Task 14 calls after a successful publish.

- [ ] **Step 1: Write the failing page test**

`src/app/features/products/products.page.spec.ts`:

```ts
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CartStore } from '@core/cart/cart.store';
import { CartPersistence } from '@core/cart/cart.persistence';
import { ProductsPage } from './products.page';

const page = (n: number, nextCursor: string | null) => ({
  items: Array.from({ length: n }, (_, i) => ({
    productId: `p${i}`,
    name: `Product ${i}`,
    thumbnailUrl: null,
    amount: 10 + i,
    currency: 'EUR',
    publishedAt: '2026-09-10T00:00:00Z',
  })),
  nextCursor,
});

describe('ProductsPage', () => {
  let fixture: ComponentFixture<ProductsPage>;
  let controller: HttpTestingController;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      imports: [ProductsPage],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        CartStore,
        { provide: CartPersistence, useValue: { read: async () => [], write: async () => undefined } },
      ],
    });

    fixture = TestBed.createComponent(ProductsPage);
    controller = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  afterEach(() => controller.verify());

  it('loads the first page with limit=20 and no cursor', () => {
    const request = controller.expectOne(
      (r) => r.url === 'http://localhost:5000/api/v1/catalog/products',
    );

    expect(request.request.params.get('limit')).toBe('20');
    expect(request.request.params.has('cursor')).toBe(false);
    request.flush(page(20, 'cursor-2'));
  });

  it('appends the next page using the reply nextCursor', async () => {
    controller
      .expectOne((r) => r.url === 'http://localhost:5000/api/v1/catalog/products')
      .flush(page(20, 'cursor-2'));
    await fixture.whenStable();

    fixture.componentInstance.loadMore();

    const second = controller.expectOne(
      (r) => r.url === 'http://localhost:5000/api/v1/catalog/products',
    );
    expect(second.request.params.get('cursor')).toBe('cursor-2');

    second.flush(page(5, null));
    await fixture.whenStable();

    expect(fixture.componentInstance.products()).toHaveLength(25);
    // A null nextCursor is the last page, so nothing asks for another.
    expect(fixture.componentInstance.hasMore()).toBe(false);
  });

  it('adds a product to the cart without calling the platform', async () => {
    controller
      .expectOne((r) => r.url === 'http://localhost:5000/api/v1/catalog/products')
      .flush(page(1, null));
    await fixture.whenStable();

    fixture.componentInstance.addToCart(fixture.componentInstance.products()[0]);

    expect(TestBed.inject(CartStore).count()).toBe(1);
    controller.verify();
  });

  it('shows the mapped banner when the listing fails', async () => {
    controller
      .expectOne((r) => r.url === 'http://localhost:5000/api/v1/catalog/products')
      .flush(
        { title: 'Too many requests', status: 429 },
        { status: 429, statusText: 'Too Many Requests' },
      );
    await fixture.whenStable();

    expect(fixture.componentInstance.error()?.kind).toBe('rateLimited');
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm test -- products.page`
Expected: FAIL — `products()` is not a function on the placeholder.

- [ ] **Step 3: Write the page**

`src/app/features/products/products.page.ts`:

```ts
import { ChangeDetectionStrategy, Component, Signal, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import {
  IonContent, IonHeader, IonInfiniteScroll, IonInfiniteScrollContent, IonItem, IonLabel,
  IonList, IonNote, IonThumbnail, IonTitle, IonToolbar, IonButton,
} from '@ionic/angular';
import { CatalogApi } from '@core/api/catalog.api';
import { ProductSummary } from '@core/api/types';
import { CartStore } from '@core/cart/cart.store';
import { DisplayError, mapError } from '@core/errors/error-mapper';
import { ErrorBannerComponent } from '@shared/error-banner.component';

/**
 * Spec §5.1. The landing tab, and it works before sign-in: the listing is
 * anonymous at the gateway and at the endpoint, so a client that demanded a
 * token here would be refusing to show what the platform publishes.
 */
@Component({
  selector: 'app-products',
  standalone: true,
  imports: [
    IonButton, IonContent, IonHeader, IonInfiniteScroll, IonInfiniteScrollContent, IonItem,
    IonLabel, IonList, IonNote, IonThumbnail, IonTitle, IonToolbar, ErrorBannerComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ion-header><ion-toolbar><ion-title>Products</ion-title></ion-toolbar></ion-header>

    <ion-content>
      <app-error-banner [error]="error()" />

      <ion-list>
        @for (product of products(); track product.productId) {
          <ion-item>
            @if (product.thumbnailUrl) {
              <ion-thumbnail slot="start">
                <img [src]="product.thumbnailUrl" [alt]="product.name" />
              </ion-thumbnail>
            }

            <ion-label>
              <h2>{{ product.name }}</h2>
              <ion-note>{{ product.amount }} {{ product.currency }}</ion-note>
            </ion-label>

            <ion-button slot="end" fill="clear" (click)="addToCart(product)">Add</ion-button>
          </ion-item>
        }
      </ion-list>

      <ion-infinite-scroll [disabled]="!hasMore()" (ionInfinite)="loadMore($event)">
        <ion-infinite-scroll-content></ion-infinite-scroll-content>
      </ion-infinite-scroll>
    </ion-content>
  `,
})
export class ProductsPage {
  private readonly catalog = inject(CatalogApi);
  private readonly cart = inject(CartStore);
  private cursor: string | null = null;

  readonly products = signal<readonly ProductSummary[]>([]);
  readonly error = signal<DisplayError | null>(null);
  /** Null nextCursor is the last page (CursorPage.cs). Nothing asks past it. */
  readonly hasMore = signal(true);

  constructor() {
    this.load();
  }

  /** Called by the publish page after a success (spec §5.5). */
  reload(): void {
    this.cursor = null;
    this.products.set([]);
    this.hasMore.set(true);
    this.load();
  }

  loadMore(event?: { target: { complete: () => void } }): void {
    this.load(() => event?.target.complete());
  }

  addToCart(product: ProductSummary): void {
    // Local only. The backend has no cart, so there is nothing to call.
    this.cart.add(product);
  }

  private load(done?: () => void): void {
    this.catalog.products(this.cursor).subscribe({
      next: (page) => {
        this.error.set(null);
        this.products.update((existing) => [...existing, ...page.items]);
        this.cursor = page.nextCursor;
        this.hasMore.set(page.nextCursor !== null);
        done?.();
      },
      error: (failure: HttpErrorResponse) => {
        this.error.set(mapError(failure));
        // Stop asking. Retrying into a 429 is how a rate limit becomes a loop.
        this.hasMore.set(false);
        done?.();
      },
    });
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- products.page`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/features/products
git commit -m "feat(products): cursor-paged listing with add to cart"
```

---

## Task 11: Cart page

**Files:**
- Modify: `src/app/features/cart/cart.page.ts`
- Test: `src/app/features/cart/cart.page.spec.ts`

**Interfaces:**
- Consumes: `CartStore` (Task 7), `CheckoutApi.quote` (Task 6), `AuthService` (Task 5), `mapError` (Task 4).
- Produces: navigation to `/tabs/cart/checkout` carrying the quote through `CheckoutHandoff`.
- Also create: `src/app/core/cart/checkout-handoff.ts` - a root-provided `CheckoutHandoff` holding the quote the cart obtained, with `clear()` alongside the signal. In core because two features share it and a feature never imports another feature. Its LIFECYCLE is part of its contract, not an afterthought: the cart writes it at checkout and clears it whenever the basket or currency changes, the checkout page reads it and clears it once the order is placed, and Task 12's route guard decides reachability from it - a guard is only as good as the lifecycle of what it reads.

- [ ] **Step 1: Write the failing test**

`src/app/features/cart/cart.page.spec.ts`:

```ts
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '@core/auth/auth.service';
import { CartPersistence } from '@core/cart/cart.persistence';
import { CartStore } from '@core/cart/cart.store';
import { CartPage } from './cart.page';

const product = (id: string) => ({
  productId: id, name: `Product ${id}`, thumbnailUrl: null,
  amount: 10, currency: 'EUR', publishedAt: '2026-09-10T00:00:00Z',
});

describe('CartPage', () => {
  let fixture: ComponentFixture<CartPage>;
  let controller: HttpTestingController;
  let store: CartStore;
  const signIn = vi.fn(async () => undefined);

  beforeEach(async () => {
    TestBed.configureTestingModule({
      imports: [CartPage],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        CartStore,
        { provide: CartPersistence, useValue: { read: async () => [], write: async () => undefined } },
        { provide: AuthService, useValue: { signIn, user: () => signal({ username: 'demo' }), accessToken: () => 't' } },
      ],
    });

    store = TestBed.inject(CartStore);
    store.add(product('p1'));
    store.add(product('p2'));

    fixture = TestBed.createComponent(CartPage);
    controller = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  afterEach(() => controller.verify());

  it('quotes with one productId per distinct product and the selected currency', () => {
    // setCurrency(), not currency.set() — `currency` is an asReadonly() view.
    fixture.componentInstance.setCurrency('GBP');
    fixture.componentInstance.getQuote();

    const request = controller.expectOne((r) => r.url.includes('/bff/v1/checkout/quote'));
    expect(request.request.params.getAll('productId')).toEqual(['p1', 'p2']);
    expect(request.request.params.get('currency')).toBe('GBP');

    request.flush({ currency: 'GBP', lines: [], total: 0, unpriced: [] });
  });

  it('shows the reply total, never a client-side sum', async () => {
    fixture.componentInstance.getQuote();
    controller.expectOne((r) => r.url.includes('/quote')).flush({
      currency: 'EUR',
      lines: [
        { productId: 'p1', name: 'Product p1', amount: 4 },
        { productId: 'p2', name: 'Product p2', amount: 4 },
      ],
      // Deliberately not 8. The BFF's number is the one shown.
      total: 99,
      unpriced: [],
    });
    await fixture.whenStable();

    expect(fixture.componentInstance.quote()?.total).toBe(99);
  });

  it('marks unpriced lines rather than hiding them, and blocks checkout', async () => {
    fixture.componentInstance.getQuote();
    controller.expectOne((r) => r.url.includes('/quote')).flush({
      currency: 'EUR',
      lines: [{ productId: 'p1', name: 'Product p1', amount: 4 }],
      total: 4,
      unpriced: ['p2'],
    });
    await fixture.whenStable();

    expect(fixture.componentInstance.isUnpriced('p2')).toBe(true);
    expect(fixture.componentInstance.lines()).toHaveLength(2);
    expect(fixture.componentInstance.canCheckout()).toBe(false);
  });

  it('enables checkout when a quote exists with no unpriced lines', async () => {
    fixture.componentInstance.getQuote();
    controller.expectOne((r) => r.url.includes('/quote')).flush({
      currency: 'EUR',
      lines: [
        { productId: 'p1', name: 'Product p1', amount: 4 },
        { productId: 'p2', name: 'Product p2', amount: 4 },
      ],
      total: 8,
      unpriced: [],
    });
    await fixture.whenStable();

    expect(fixture.componentInstance.canCheckout()).toBe(true);
  });

  it('prompts for sign-in on a 401 instead of showing a raw error', async () => {
    fixture.componentInstance.getQuote();
    controller
      .expectOne((r) => r.url.includes('/quote'))
      .flush({ title: 'Unauthorized', status: 401 }, { status: 401, statusText: 'Unauthorized' });
    await fixture.whenStable();

    expect(signIn).toHaveBeenCalledOnce();
  });

  it('discards a stale quote when a quantity changes', async () => {
    fixture.componentInstance.getQuote();
    controller.expectOne((r) => r.url.includes('/quote')).flush({
      currency: 'EUR', lines: [], total: 8, unpriced: [],
    });
    await fixture.whenStable();

    fixture.componentInstance.setQuantity('p1', 5);

    // A quote priced two of something is not a quote for five of it.
    expect(fixture.componentInstance.quote()).toBeNull();
    expect(fixture.componentInstance.canCheckout()).toBe(false);
  });
});
```

- [ ] **Step 2: Run and watch it fail, then write the page**

Run: `npm test -- cart.page` → FAIL.

`src/app/features/cart/cart.page.ts`:

```ts
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { Router } from '@angular/router';
import {
  IonButton, IonContent, IonHeader, IonItem, IonLabel, IonList, IonNote, IonSelect,
  IonSelectOption, IonTitle, IonToolbar,
} from '@ionic/angular';
import { CheckoutApi } from '@core/api/checkout.api';
import { QuoteResponse } from '@core/api/types';
import { AuthService } from '@core/auth/auth.service';
import { CartStore } from '@core/cart/cart.store';
import { CheckoutHandoff } from '@core/cart/checkout-handoff';
import { DisplayError, mapError } from '@core/errors/error-mapper';
import { ErrorBannerComponent } from '@shared/error-banner.component';

/** Spec §5.2. */
@Component({
  selector: 'app-cart',
  standalone: true,
  imports: [
    IonButton, IonContent, IonHeader, IonItem, IonLabel, IonList, IonNote, IonSelect,
    IonSelectOption, IonTitle, IonToolbar, ErrorBannerComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ion-header><ion-toolbar><ion-title>Cart</ion-title></ion-toolbar></ion-header>

    <ion-content>
      <app-error-banner [error]="error()" />

      <ion-list>
        @for (line of lines(); track line.productId) {
          <ion-item>
            <ion-label>
              <h2>{{ line.name }}</h2>
              <ion-note>
                Listing price {{ line.amount }} {{ line.currency }} — the quote is the price that counts
              </ion-note>
              @if (quotedPrices()[line.productId] !== undefined) {
                <ion-note>
                  Quoted {{ quotedPrices()[line.productId] }} {{ currency() }} each
                  &times; {{ line.quantity }}
                </ion-note>
              }
              @if (isUnpriced(line.productId)) {
                <ion-note color="warning">Not priced in {{ currency() }}</ion-note>
              }
            </ion-label>

            <ion-button slot="end" fill="clear"
              (click)="setQuantity(line.productId, line.quantity - 1)">−</ion-button>
            <ion-note slot="end">{{ line.quantity }}</ion-note>
            <ion-button slot="end" fill="clear"
              (click)="setQuantity(line.productId, line.quantity + 1)">+</ion-button>
          </ion-item>
        }
      </ion-list>

      <ion-item>
        <ion-select label="Currency" [value]="currency()"
          (ionChange)="setCurrency($any($event).detail.value)">
          @for (code of currencies; track code) {
            <ion-select-option [value]="code">{{ code }}</ion-select-option>
          }
        </ion-select>
      </ion-item>

      <ion-button expand="block" [disabled]="store.isEmpty()" (click)="getQuote()">Get quote</ion-button>

      @if (quote(); as q) {
        <ion-item>
          <ion-label>
            <strong>Quoted unit prices: {{ q.total }} {{ q.currency }}</strong>
            <ion-note>
              One unit of each product. The platform prices products, not baskets —
              the amount charged is computed when the order is placed.
            </ion-note>
          </ion-label>
        </ion-item>
      }

      <ion-button expand="block" [disabled]="!canCheckout()" (click)="checkout()">Checkout</ion-button>
    </ion-content>
  `,
})
export class CartPage {
  private readonly checkoutApi = inject(CheckoutApi);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly handoff = inject(CheckoutHandoff);

  protected readonly store = inject(CartStore);
  /**
   * A convenience selection, NOT a platform vocabulary — which is why it is
   * three codes and not a mirrored constant. The backend constrains currency
   * only as `^[A-Za-z]{3}\z` (Catalog PublishProductValidator.cs, Ordering
   * PlaceOrderValidator.cs): any three letters are legal. Listing three without
   * saying so would read as "the platform supports three currencies", which is
   * false, and the citation rule exists to keep those two apart.
   */
  protected readonly currencies = ['EUR', 'GBP', 'USD'] as const;

  /**
   * Bumped by `invalidateQuote()`. `getQuote()` captures the generation it
   * was called under and checks it again in both the success and error
   * branches when the response lands; a response whose generation no longer
   * matches was superseded by a quantity or currency change that invalidated
   * it, and is dropped rather than applied — the same shape, deliberately,
   * as `ProductsPage.generation` guards a `loadMore()` in flight against a
   * `reload()` that started a fresh sequence underneath it. Without this, a
   * `getQuote()` in flight when the user taps `+` or switches currency lands
   * AFTER `invalidateQuote()` has nulled the now-stale quote, and silently
   * restores a quote priced for a basket or currency that no longer exists —
   * exactly what `canCheckout()` exists to keep off screen.
   */
  private generation = 0;

  readonly lines = this.store.lines;

  // Writable privately, readonly to everyone else — the shape CartStore.lines
  // and CommandId.current already use. `readonly` alone guards the field
  // binding, not `.set()`, and the checkout page holds a reference to this
  // service's neighbours.
  private readonly currencyState = signal<string>('EUR');
  private readonly quoteState = signal<QuoteResponse | null>(null);
  private readonly errorState = signal<DisplayError | null>(null);

  readonly currency = this.currencyState.asReadonly();
  readonly quote = this.quoteState.asReadonly();
  readonly error = this.errorState.asReadonly();

  /**
   * Enabled only when a quote exists and prices every line. The BFF names the
   * gap in `unpriced` rather than failing, so the client must read it — an
   * order placed for a line nothing could price is an order for a product the
   * platform has no price for.
   */
  readonly canCheckout = computed(() => {
    const q = this.quote();
    return q !== null && q.unpriced.length === 0 && !this.store.isEmpty();
  });

  isUnpriced(productId: string): boolean {
    return this.quote()?.unpriced.includes(productId) ?? false;
  }

  /**
   * Quoted price of ONE unit, by product id. Empty before a quote exists.
   *
   * Shown beside the quantity rather than multiplied by it. CheckoutEndpoints.cs
   * totals `lines.Sum(line => line.Amount)` over `productId.Distinct()`, and the
   * request carries no quantities at all, so the reply's `total` is the sum of
   * one unit of each distinct product — NOT the basket. Spec 5.2's rule that the
   * client never sums money stands; what was wrong was calling that number a
   * basket total. Multiplying here would be the client computing money, which is
   * exactly what QuoteResponse.cs computes Total server-side to prevent.
   *
   * A record rather than a method, and the template tests `!== undefined` rather
   * than truthiness: a price of zero is legal (PublishProductValidator.cs allows
   * `GreaterThanOrEqualTo(0)`), and `@if (price; as p)` would hide a free product
   * as though it had never been quoted.
   */
  readonly quotedPrices = computed<Readonly<Record<string, number>>>(() => {
    const lines = this.quote()?.lines ?? [];
    return Object.fromEntries(lines.map((line) => [line.productId, line.amount]));
  });

  setQuantity(productId: string, quantity: number): void {
    this.store.setQuantity(productId, quantity);
    this.invalidateQuote();
  }

  setCurrency(currency: string): void {
    this.currencyState.set(currency);
    this.invalidateQuote();
  }

  getQuote(): void {
    const generation = this.generation;

    this.checkoutApi.quote(this.store.productIds(), this.currency()).subscribe({
      next: (quote) => {
        // Superseded by an invalidateQuote() (a quantity or currency change)
        // that started a new generation while this request was in flight.
        // Applying it now would restore a quote for a basket or currency
        // that no longer exists.
        if (generation !== this.generation) return;

        this.errorState.set(null);
        this.quoteState.set(quote);
      },
      error: (failure: HttpErrorResponse) => {
        if (generation !== this.generation) return;

        const displayed = mapError(failure);
        this.errorState.set(displayed);
        this.quoteState.set(null);

        // The quote requires sign-in; the button prompts for it (spec §5.2).
        //
        // .catch(), not a bare `void`. signIn() rejects when the identity
        // provider is unreachable: WebAuthStrategy retries the discovery
        // document there, because initCodeFlow() with no loginUrl silently
        // does nothing rather than navigating. Under `void` that rejection
        // becomes an unhandled promise rejection and the user gets a sign-in
        // button that appears to do nothing — the same class of bug as the
        // blank app the initializer fix removed, one layer up.
        //
        // mapError() takes the rejection as `unknown`, not `HttpErrorResponse`:
        // angular-oauth2-oidc's loadDiscoveryDocument(), which signIn() awaits,
        // can reject with a bare string rather than an HTTP error — there is no
        // response to type it as. See error-mapper.ts's non-HttpErrorResponse
        // branch, added for exactly this call.
        if (displayed.kind === 'signIn') {
          this.auth.signIn().catch((failure) => {
            this.errorState.set(mapError(failure));
          });
        }
      },
    });
  }

  checkout(): void {
    // The quote travels through core rather than through a route parameter: a
    // QuoteResponse does not belong in a URL, and a feature never imports
    // another feature (spec §3).
    //
    // Asserted non-null: the template only enables this button behind
    // canCheckout(), which requires a quote to exist. The guard reads the
    // very signal being asserted, so the two cannot disagree.
    this.handoff.set(this.quote()!);
    void this.router.navigate(['/tabs/cart/checkout']);
  }

  /**
   * A quote describes a specific set of lines in a specific currency; change
   * either and it is stale. Nulling `quoteState` alone does not finish the
   * job: a `getQuote()` issued before the change may still be in flight, and
   * the checkout handoff may still hold what the stale quote produced.
   * Bumping `generation` drops that in-flight response when it lands, the
   * same way `ProductsPage.reload()` drops a superseded `loadMore()`;
   * clearing the handoff keeps the checkout route guard from trusting a
   * quote priced for a basket or currency that no longer exists.
   */
  private invalidateQuote(): void {
    this.generation++;
    this.quoteState.set(null);
    this.handoff.clear();
  }
}
```

And `src/app/core/cart/checkout-handoff.ts`:

```ts
import { Injectable, signal } from '@angular/core';
import { QuoteResponse } from '@core/api/types';

/**
 * The quote the cart obtained, read by the checkout page. In core because two
 * features share it — the same reason the cart store is here (spec §3).
 */
@Injectable({ providedIn: 'root' })
export class CheckoutHandoff {
  // Private-writable, public asReadonly() — the convention CartStore.lines,
  // CommandIdentity.current and CatalogRefresh.current all use. quoteGuard
  // makes this signal a route-reachability decision, not just a data
  // carrier, so `readonly` alone (which guards the field binding, not
  // `.set()`) is not enough: the guard's guarantee is only as strong as
  // the write contract, and the write contract belongs in the type rather
  // than in a comment asking callers to behave.
  private readonly quoteState = signal<QuoteResponse | null>(null);

  readonly quote = this.quoteState.asReadonly();

  /**
   * Takes QuoteResponse, not QuoteResponse | null, on purpose: quoteGuard
   * treats "a quote was set" as the route-reachability fact, and a
   * nullable setter would let that fact be asserted falsely. Callers that
   * have no quote call clear().
   */
  set(quote: QuoteResponse): void {
    this.quoteState.set(quote);
  }

  clear(): void {
    this.quoteState.set(null);
  }
}
```

Run: `npm test -- cart.page`
Expected: PASS, 6 tests.

- [ ] **Step 3: Commit**

```bash
git add src/app/features/cart src/app/core/cart/checkout-handoff.ts
git commit -m "feat(cart): quantities, currency, BFF quote with unpriced lines named"
```

---

## Task 12: Checkout page

**Files:**
- Modify: `src/app/features/checkout/checkout.page.ts`
- Create: `src/app/core/cart/quote.guard.ts`
- Modify: `src/app/app.routes.ts` — guard `cart/checkout`
- Test: `src/app/features/checkout/checkout.page.spec.ts`
- Test: `src/app/core/cart/quote.guard.spec.ts`

**Interfaces:**
- Consumes: `CommandIdentity` (Task 8), `OrderingApi.place` (Task 6), `CartStore` (Task 7), `CheckoutHandoff` (Task 11), `mapError` (Task 4).

> **This route needs a guard, and without one the page orders in a currency
> nobody chose.** `CheckoutHandoff` is an in-memory root signal; the cart is
> persisted through Preferences. So a reload on `/tabs/cart/checkout` — or a
> deep link, or a back-navigation after the handoff was cleared — arrives with
> lines in the cart and `quote() === null`. Reading the currency as
> `this.handoff.quote()?.currency ?? 'EUR'` then places a real order in EUR
> for a basket the platform never priced. The fallback is not a default; it is
> a guess about money.
>
> The guard sends that navigation back to `/tabs/cart`, where **Get quote**
> is. With it in place the currency can be read from a quote that is known to
> exist, and the page never has to invent one.

- [ ] **Step 1: Write the guard and its test**

`src/app/core/cart/quote.guard.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { UrlTree, provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';
import { CheckoutHandoff } from './checkout-handoff';
import { quoteGuard } from './quote.guard';

describe('quoteGuard', () => {
  const run = () =>
    TestBed.runInInjectionContext(() => quoteGuard(null as never, null as never));

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
  });

  it('sends a checkout with no quote back to the cart', () => {
    const result = run();

    expect(result).toBeInstanceOf(UrlTree);
    expect((result as UrlTree).toString()).toBe('/tabs/cart');
  });

  it('lets a checkout with a quote through', () => {
    TestBed.inject(CheckoutHandoff).quote.set({
      currency: 'GBP', lines: [{ productId: 'p1', name: 'Widget', amount: 10 }],
      total: 10, unpriced: [],
    });

    expect(run()).toBe(true);
  });
});
```

`src/app/core/cart/quote.guard.ts`:

```ts
import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { CheckoutHandoff } from './checkout-handoff';

/**
 * The checkout page may only be entered with a quote in hand.
 *
 * The handoff lives in memory; the cart lives in Preferences. A reload on
 * /tabs/cart/checkout therefore arrives with lines but no quote, as does a
 * deep link and a back-navigation after a placed order cleared the handoff.
 * Sending that back to the cart is not defensive tidying — it is what lets the
 * checkout page read the currency from the quote without a fallback, and a
 * fallback currency is a guess about money.
 *
 * In core beside the handoff it reads, because a feature never imports another
 * feature (spec §3).
 */
export const quoteGuard: CanActivateFn = () => {
  if (inject(CheckoutHandoff).quote() !== null) return true;

  // A UrlTree, not `false`. Returning false cancels the navigation and leaves
  // the user on whatever was underneath — which, on a cold reload of this URL,
  // is nothing at all. Redirecting states where they ended up and puts Get
  // quote in front of them.
  return inject(Router).createUrlTree(['/tabs/cart']);
};
```

Then in `src/app/app.routes.ts`, add to the `cart/checkout` route:

```ts
        canActivate: [quoteGuard],
```

- [ ] **Step 2: Write the failing page test**

`src/app/features/checkout/checkout.page.spec.ts`. The command-id lifecycle is the point of this page, so the tests are about the id. Every test seeds `CheckoutHandoff.quote` in `beforeEach`, because the guard now makes an unquoted checkout unreachable and a test that constructs one is testing a state the app cannot enter:

```ts
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CartPersistence } from '@core/cart/cart.persistence';
import { CartStore } from '@core/cart/cart.store';
import { CheckoutHandoff } from '@core/cart/checkout-handoff';
import { CheckoutPage } from './checkout.page';

const validAddress = {
  line1: '1 Example Street', line2: '', city: 'Doha', postalCode: '00000', country: 'QA',
};

describe('CheckoutPage', () => {
  let fixture: ComponentFixture<CheckoutPage>;
  let controller: HttpTestingController;
  let navigate: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      imports: [CheckoutPage],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        CartStore,
        { provide: CartPersistence, useValue: { read: async () => [], write: async () => undefined } },
      ],
    });

    TestBed.inject(CartStore).add({
      productId: 'p1', name: 'Widget', thumbnailUrl: null,
      amount: 10, currency: 'EUR', publishedAt: '2026-09-10T00:00:00Z',
    });
    TestBed.inject(CheckoutHandoff).quote.set({
      currency: 'EUR', lines: [{ productId: 'p1', name: 'Widget', amount: 10 }], total: 10, unpriced: [],
    });

    navigate = vi.fn(async () => true);
    vi.spyOn(TestBed.inject(Router), 'navigate').mockImplementation(navigate as never);

    fixture = TestBed.createComponent(CheckoutPage);
    controller = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    await fixture.whenStable();

    fixture.componentInstance.form.setValue(validAddress);
  });

  afterEach(() => controller.verify());

  it('carries the currency from the quote, not from a picker', () => {
    expect(fixture.componentInstance.currency()).toBe('EUR');
  });

  it('sends the cart as items and the address as five fields with line2 null when blank', () => {
    fixture.componentInstance.placeOrder();

    const body = controller.expectOne('http://localhost:5000/api/v1/orders').request.body;

    expect(body.items).toEqual([{ productId: 'p1', quantity: 1 }]);
    expect(body.shippingAddress).toEqual({
      line1: '1 Example Street', line2: null, city: 'Doha', postalCode: '00000', country: 'QA',
    });
    expect(body.currency).toBe('EUR');
  });

  it('reuses the same commandId when a 5xx is retried, so the retry is a replay', async () => {
    fixture.componentInstance.placeOrder();
    const first = controller.expectOne('http://localhost:5000/api/v1/orders');
    const firstId = first.request.body.commandId;
    first.flush({ title: 'Server error', status: 500 }, { status: 500, statusText: 'Error' });
    await fixture.whenStable();

    fixture.componentInstance.placeOrder();
    const second = controller.expectOne('http://localhost:5000/api/v1/orders');

    expect(second.request.body.commandId).toBe(firstId);
    second.flush('44444444-4444-4444-4444-444444444444', { status: 200, statusText: 'OK' });
  });

  it('mints a new commandId after the form is edited following a validation failure', async () => {
    fixture.componentInstance.placeOrder();
    const first = controller.expectOne('http://localhost:5000/api/v1/orders');
    const firstId = first.request.body.commandId;
    first.flush(
      { status: 400, errors: { 'ShippingAddress.PostalCode': ['Not a postal code.'] } },
      { status: 400, statusText: 'Bad Request' },
    );
    await fixture.whenStable();

    fixture.componentInstance.form.controls.postalCode.setValue('12345');
    fixture.componentInstance.placeOrder();

    const second = controller.expectOne('http://localhost:5000/api/v1/orders');
    expect(second.request.body.commandId).not.toBe(firstId);
    second.flush('44444444-4444-4444-4444-444444444444', { status: 200, statusText: 'OK' });
  });

  it('treats command.already_committed as success pending confirmation and moves on', async () => {
    fixture.componentInstance.placeOrder();
    controller.expectOne('http://localhost:5000/api/v1/orders').flush(
      { status: 409, code: 'command.already_committed', detail: 'Already applied.' },
      { status: 409, statusText: 'Conflict' },
    );
    await fixture.whenStable();

    // No order id came back, so the placed page is reached with the sentinel
    // and says the id was already committed.
    expect(navigate).toHaveBeenCalledWith(['/tabs/cart/placed', 'already-committed']);
  });

  it('does not navigate on request.in_progress — the first attempt is still running', async () => {
    fixture.componentInstance.placeOrder();
    controller.expectOne('http://localhost:5000/api/v1/orders').flush(
      { status: 409, code: 'request.in_progress', detail: 'Already in progress. Retry.' },
      { status: 409, statusText: 'Conflict' },
    );
    await fixture.whenStable();

    expect(navigate).not.toHaveBeenCalled();
    expect(fixture.componentInstance.error()?.kind).toBe('inProgress');
  });

  it('clears the cart and navigates to the order on success', async () => {
    fixture.componentInstance.placeOrder();
    controller
      .expectOne('http://localhost:5000/api/v1/orders')
      .flush('44444444-4444-4444-4444-444444444444', { status: 200, statusText: 'OK' });
    await fixture.whenStable();

    expect(TestBed.inject(CartStore).isEmpty()).toBe(true);
    expect(navigate).toHaveBeenCalledWith([
      '/tabs/cart/placed', '44444444-4444-4444-4444-444444444444',
    ]);
  });

  it('surfaces field errors keyed as the backend keyed them', async () => {
    fixture.componentInstance.placeOrder();
    controller.expectOne('http://localhost:5000/api/v1/orders').flush(
      { status: 400, errors: { 'ShippingAddress.City': ['City is required.'] } },
      { status: 400, statusText: 'Bad Request' },
    );
    await fixture.whenStable();

    expect(fixture.componentInstance.error()?.fields).toEqual({
      'ShippingAddress.City': ['City is required.'],
    });
  });
});
```

- [ ] **Step 3: Run and watch it fail, then write the page**

Run: `npm test -- checkout.page` → FAIL.

`src/app/features/checkout/checkout.page.ts`:

```ts
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import {
  IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonInput, IonItem, IonNote,
  IonTitle, IonToolbar,
} from '@ionic/angular';
import { OrderingApi } from '@core/api/ordering.api';
import { PERMISSIONS, PlaceOrderCommand } from '@core/api/types';
import { CartStore } from '@core/cart/cart.store';
import { CheckoutHandoff } from '@core/cart/checkout-handoff';
import { ALREADY_COMMITTED, CommandIdentity } from '@core/commands/command-id';
import { DisplayError, mapError } from '@core/errors/error-mapper';
import { ErrorBannerComponent } from '@shared/error-banner.component';

/**
 * Spec §5.3. The address form mirrors AddressDto's five fields with the same
 * required set — line2 optional — and the currency is carried from the quote
 * rather than picked again: pricing in one currency and ordering in another is
 * two different numbers with one label.
 */
@Component({
  selector: 'app-checkout',
  standalone: true,
  imports: [
    IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonInput, IonItem, IonNote,
    IonTitle, IonToolbar, ReactiveFormsModule, ErrorBannerComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ion-header>
      <ion-toolbar>
        <ion-buttons slot="start"><ion-back-button defaultHref="/tabs/cart"></ion-back-button></ion-buttons>
        <ion-title>Checkout</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content>
      <app-error-banner [error]="error()" />

      <form [formGroup]="form" (ngSubmit)="placeOrder()">
        <ion-item><ion-input label="Line 1" formControlName="line1" required></ion-input></ion-item>
        <ion-item><ion-input label="Line 2" formControlName="line2"></ion-input></ion-item>
        <ion-item><ion-input label="City" formControlName="city" required></ion-input></ion-item>
        <ion-item><ion-input label="Postal code" formControlName="postalCode" required></ion-input></ion-item>
        <ion-item><ion-input label="Country" formControlName="country" required></ion-input></ion-item>

        <!--
          Reads the handoff directly, with optional chaining, rather than
          currency()'s non-null assertion. On success and on already_committed
          this component calls handoff.clear() before router.navigate()
          resolves, which nulls the signal currency() reads. That alone is
          enough to mark it dirty — no other signal needs to change on the
          same tick, because a computed re-evaluates whenever ITS OWN
          dependency changes, not because something else in the template
          did. Zoneless CD then re-renders the still-mounted view on the
          next tick and currency() would throw on the now-null quote
          unconditionally. currency() itself stays asserted: placeOrder()
          reads the handoff directly too (see below) and returns before
          ever calling currency() with a null quote.
        -->
        @if (handoff.quote(); as quote) {
          <ion-item>
            <ion-note>Ordering in {{ quote.currency }}, carried from the quote.</ion-note>
          </ion-item>
        }

        <ion-button expand="block" type="submit"
          [disabled]="form.invalid || identity.isSpent() || !handoff.quote()">
          Place order
        </ion-button>
      </form>
    </ion-content>
  `,
})
export class CheckoutPage {
  private readonly ordering = inject(OrderingApi);
  private readonly cart = inject(CartStore);
  // Protected, not private: the template reads it directly (see the @if
  // guard below), the same convention CartPage.store uses.
  protected readonly handoff = inject(CheckoutHandoff);
  private readonly router = inject(Router);

  /**
   * Minted when the page is entered and held with the form. Every submission
   * uses it; only a success, or an edit after a validation failure, mints a
   * new one. This is the one place the client holds state across requests on
   * purpose (spec §5.3).
   */
  readonly identity = new CommandIdentity();

  readonly form = new FormGroup({
    line1: new FormControl('', { nonNullable: true, validators: Validators.required }),
    // Optional, exactly as AddressDto has it nullable.
    line2: new FormControl('', { nonNullable: true }),
    city: new FormControl('', { nonNullable: true, validators: Validators.required }),
    postalCode: new FormControl('', { nonNullable: true, validators: Validators.required }),
    country: new FormControl('', { nonNullable: true, validators: Validators.required }),
  });

  readonly error = signal<DisplayError | null>(null);
  /**
   * Carried from the quote, with no fallback — quoteGuard guarantees a quote
   * exists before this page is reachable. A `?? 'EUR'` here would be a guess
   * about money, and it would only ever be read on the path where the guess is
   * certainly wrong: no quote means nothing priced this basket in any currency.
   */
  readonly currency = computed(() => this.handoff.quote()!.currency);

  constructor() {
    this.form.valueChanges.subscribe(() => this.identity.onEdit());
  }

  placeOrder(): void {
    // Guards the same window the button's [disabled] binding guards, and for
    // the same reason: after a success or an already_committed, handoff.clear()
    // has run but router.navigate() has not resolved yet, identity.isSpent()
    // may already be false again (onSuccess() clears it), and the form is
    // still valid — so a click landing in that gap would otherwise reach
    // currency()'s assertion with a null quote. This is deliberately NOT an
    // in-flight guard: a double-click before any response lands still sends
    // two requests under the same commandId, and the platform answering the
    // second with request.in_progress is the idempotency mechanism working
    // as designed, not a bug this method should suppress.
    const quote = this.handoff.quote();
    if (quote === null) return;

    const address = this.form.getRawValue();

    const command: PlaceOrderCommand = {
      commandId: this.identity.current(),
      items: this.cart.lines().map((line) => ({
        productId: line.productId,
        quantity: line.quantity,
      })),
      shippingAddress: {
        line1: address.line1,
        // Empty means absent. AddressDto's Line2 is nullable and the backend
        // reads null as "no second line"; an empty string is a second line
        // that happens to be blank, which is a different claim.
        line2: address.line2.trim() === '' ? null : address.line2,
        city: address.city,
        postalCode: address.postalCode,
        country: address.country,
      },
      currency: quote.currency,
    };

    this.ordering.place(command).subscribe({
      next: (orderId) => {
        this.error.set(null);
        this.identity.onSuccess();
        this.spendQuote();
        void this.router.navigate(['/tabs/cart/placed', orderId]);
      },
      error: (failure: HttpErrorResponse) => {
        // The permission comes from the route's own knowledge of what it
        // needs, not from the response — the 403 deliberately names none.
        const displayed = mapError(failure, { permission: PERMISSIONS.ordersWrite });
        this.error.set(displayed);
        this.identity.onFailure(displayed);

        // command.already_committed: the earlier submission won. Treat it as
        // success pending confirmation and move to the placed page with a note
        // — there is no order id to show, because the platform no longer holds
        // the result and exposes no endpoint to read it back.
        if (displayed.kind === 'alreadyCommitted') {
          this.spendQuote();
          void this.router.navigate(['/tabs/cart/placed', ALREADY_COMMITTED]);
        }

        // request.in_progress and every other failure stay on this page. The
        // id is unchanged, so the user's next click is a replay rather than a
        // second order.
      },
    });
  }

  /**
   * Both paths that end the checkout flow — a 200 and command.already_committed
   * — need the same two writes, and for the same reason: the order exists (or,
   * for already_committed, might as well), so the basket that produced it is
   * spent. Clearing only the cart is half of that: quoteGuard reads the
   * handoff to decide whether this route is reachable at all, so a quote left
   * behind lets the user navigate back into checkout with an emptied cart and
   * be waved straight through. CartPage clears the handoff whenever the
   * basket or currency changes (invalidateQuote()); this is the other half of
   * that same contract, for the path where the basket empties because the
   * order was placed rather than edited.
   */
  private spendQuote(): void {
    this.cart.clear();
    this.handoff.clear();
  }
}
```

Run: `npm test -- checkout.page`
Expected: PASS, 8 tests.

- [ ] **Step 4: Commit**

```bash
git add src/app/features/checkout src/app/core/cart/quote.guard.ts   src/app/core/cart/quote.guard.spec.ts src/app/app.routes.ts
git commit -m "feat(checkout): address form, command-id lifecycle, and a guarded quote"
```

---

## Task 13: Order placed page

**Files:**
- Modify: `src/app/features/order-placed/order-placed.page.ts`
- Test: `src/app/features/order-placed/order-placed.page.spec.ts`

- [ ] **Step 1: Write the failing test**

`src/app/features/order-placed/order-placed.page.spec.ts`:

```ts
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject, map } from 'rxjs';
import { afterEach, describe, expect, it } from 'vitest';
import { OrderPlacedPage } from './order-placed.page';

const GUID_A = '44444444-4444-4444-4444-444444444444';
const GUID_B = '55555555-5555-5555-5555-555555555555';

function mount(id: string): { fixture: ComponentFixture<OrderPlacedPage>; paramMap: BehaviorSubject<string> } {
  TestBed.resetTestingModule();

  // A BehaviorSubject-backed paramMap, not just `snapshot`, so the reuse
  // test below can drive a second id through the SAME ActivatedRoute the
  // way Angular's `advanceActivatedRoute` does on a reused route — the path
  // that exists whenever a route's `RouteReuseStrategy` reuses a component
  // across two different `:id`s, IonicRouteStrategy included.
  const paramMap = new BehaviorSubject(id);

  TestBed.configureTestingModule({
    imports: [OrderPlacedPage],
    providers: [
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      {
        provide: ActivatedRoute,
        useValue: {
          snapshot: { paramMap: { get: () => paramMap.value } },
          paramMap: paramMap.pipe(map((value) => convertToParamMap({ id: value }))),
        },
      },
    ],
  });

  const fixture = TestBed.createComponent(OrderPlacedPage);
  fixture.detectChanges();
  return { fixture, paramMap };
}

describe('OrderPlacedPage', () => {
  let controller: HttpTestingController;

  afterEach(() => controller?.verify());

  it('renders the order id and the no-read-endpoint sentence for a real order', () => {
    const { fixture } = mount(GUID_A);

    expect(fixture.nativeElement.textContent).toContain(GUID_A);
    expect(fixture.nativeElement.textContent).toContain(
      'The platform exposes no endpoint that reads an order back',
    );

    const button = [...fixture.nativeElement.querySelectorAll('ion-button')].find(
      (el: HTMLElement) => el.textContent?.trim() === 'Cancel order',
    );
    expect(button).toBeTruthy();
  });

  it('sends customer_request and offers no other reason, via the rendered Cancel button', () => {
    const { fixture } = mount(GUID_A);
    controller = TestBed.inject(HttpTestingController);

    const button: HTMLElement = [...fixture.nativeElement.querySelectorAll('ion-button')].find(
      (el: HTMLElement) => el.textContent?.trim() === 'Cancel order',
    );
    button.click();

    // The other four codes are the platform's own findings — the saga's stock
    // outcomes and Payments' results. A customer cannot truthfully assert any
    // of them, and the endpoint stamps origin User whatever arrives.
    const request = controller.expectOne((r) => r.url.endsWith('/cancel'));
    expect(request.request.body).toEqual({ reason: 'customer_request' });

    // The half of the name that the body assertion does not cover: no picker
    // is rendered at all. Asserting CANCEL_REASONS contains customer_request
    // would prove nothing here — that is a fact about a frozen constant, true
    // whatever this page puts on screen.
    expect(fixture.nativeElement.querySelector('ion-select')).toBeNull();

    request.flush(null, { status: 204, statusText: 'No Content' });
  });

  it('reports the 204 with the cancelled note, clearing a prior error', async () => {
    const { fixture } = mount(GUID_A);
    controller = TestBed.inject(HttpTestingController);

    fixture.componentInstance.cancel();
    controller
      .expectOne((r) => r.url.endsWith('/cancel'))
      .flush({ title: 'Forbidden', status: 403 }, { status: 403, statusText: 'Forbidden' });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.componentInstance.error()).not.toBeNull();

    fixture.componentInstance.cancel();
    controller
      .expectOne((r) => r.url.endsWith('/cancel'))
      .flush(null, { status: 204, statusText: 'No Content' });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.componentInstance.cancelled()).toBe(true);
    expect(fixture.componentInstance.error()).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Cancelled. The platform answered 204.');
  });

  it('guards a second tap while a cancel is in flight — no commandId here to replay under', () => {
    const { fixture } = mount(GUID_A);
    controller = TestBed.inject(HttpTestingController);

    fixture.componentInstance.cancel();
    fixture.componentInstance.cancel();

    // Exactly one request outstanding: expectOne throws if a second one was
    // sent. Flushing it satisfies afterEach's verify().
    controller
      .expectOne((r) => r.url.endsWith('/cancel'))
      .flush(null, { status: 204, statusText: 'No Content' });
  });

  it('maps a 403 to a banner naming orders:cancel', async () => {
    const { fixture } = mount(GUID_A);
    controller = TestBed.inject(HttpTestingController);

    fixture.componentInstance.cancel();
    controller
      .expectOne((r) => r.url.endsWith('/cancel'))
      .flush({ title: 'Forbidden', status: 403 }, { status: 403, statusText: 'Forbidden' });
    await fixture.whenStable();

    expect(fixture.componentInstance.error()).toMatchObject({
      kind: 'forbidden',
      permission: 'orders:cancel',
    });
  });

  it('hides cancel and explains when the command already committed', () => {
    const { fixture } = mount('already-committed');

    expect(fixture.componentInstance.canCancel()).toBe(false);
    expect(fixture.componentInstance.alreadyCommitted()).toBe(true);

    const text: string = fixture.nativeElement.textContent;
    expect(text).toContain('Already committed');
    expect(text).toContain('already been applied');
    // No order id came back, so there is nothing to cancel and nothing to
    // read — neither the sentinel nor a real id belongs on screen here.
    expect(text).not.toContain('already-committed');
    expect(
      [...fixture.nativeElement.querySelectorAll('ion-button')].some(
        (el: HTMLElement) => el.textContent?.trim() === 'Cancel order',
      ),
    ).toBe(false);
  });

  it('drives a new :id through the route and updates what a reused instance shows', async () => {
    const { fixture, paramMap } = mount(GUID_A);
    controller = TestBed.inject(HttpTestingController);

    // Cancel order A on this instance...
    fixture.componentInstance.cancel();
    controller
      .expectOne((r) => r.url.endsWith('/cancel'))
      .flush(null, { status: 204, statusText: 'No Content' });
    await fixture.whenStable();
    expect(fixture.componentInstance.cancelled()).toBe(true);

    // ...then simulate Angular's default RouteReuseStrategy reusing this
    // SAME component across placed/A -> placed/B: advanceActivatedRoute
    // swaps `snapshot` in place and emits the new ParamMap on `paramMap`
    // without a new component ever being constructed. IonicRouteStrategy
    // (now installed in app.config.ts) prevents this reuse app-wide, but the
    // page must be correct even if it were not.
    paramMap.next(GUID_B);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.componentInstance.orderId()).toBe(GUID_B);
    expect(fixture.nativeElement.textContent).toContain(GUID_B);
    expect(fixture.nativeElement.textContent).not.toContain(GUID_A);

    // Order A's "cancelled" note must not bleed onto order B, which this
    // instance has never touched.
    expect(fixture.componentInstance.cancelled()).toBe(false);
    expect(fixture.nativeElement.textContent).not.toContain('Cancelled. The platform answered 204.');
  });
});
```

- [ ] **Step 2: Run and watch it fail, then write the page**

`src/app/features/order-placed/order-placed.page.ts`:

```ts
import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import { map } from 'rxjs';
import {
  IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonItem, IonLabel, IonNote,
  IonText, IonTitle, IonToolbar,
} from '@ionic/angular';
import { OrderingApi } from '@core/api/ordering.api';
import { CancelReason, PERMISSIONS } from '@core/api/types';
import { DisplayError, mapError } from '@core/errors/error-mapper';
import { ALREADY_COMMITTED } from '@core/commands/command-id';
import { ErrorBannerComponent } from '@shared/error-banner.component';

/**
 * Spec §5.4. The page states, in one sentence, that the platform exposes no
 * order read — Ordering has no read endpoint and OrderingPermissions.cs says
 * why there is no `orders:read` to require. It does not poll, fake a status or
 * invent one.
 */
@Component({
  selector: 'app-order-placed',
  standalone: true,
  imports: [
    IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonItem, IonLabel, IonNote,
    IonText, IonTitle, IonToolbar, ErrorBannerComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ion-header>
      <ion-toolbar>
        <ion-buttons slot="start"><ion-back-button defaultHref="/tabs/cart"></ion-back-button></ion-buttons>
        <ion-title>Order placed</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content>
      <app-error-banner [error]="error()" />

      @if (alreadyCommitted()) {
        <ion-item>
          <ion-label>
            <h2>Already committed</h2>
            <ion-note>
              The platform reported that this command id had already been applied, and it no longer
              holds the result. The order exists; its id is not recoverable from here.
            </ion-note>
          </ion-label>
        </ion-item>
      } @else {
        <ion-item>
          <ion-label>
            <h2>Order</h2>
            <ion-text><code>{{ orderId() }}</code></ion-text>
          </ion-label>
        </ion-item>
      }

      <ion-item>
        <ion-note>
          The platform exposes no endpoint that reads an order back, so no status is shown here.
        </ion-note>
      </ion-item>

      @if (canCancel()) {
        <ion-item>
          <ion-note>
            Cancelling here is recorded as the customer's own request.
          </ion-note>
        </ion-item>

        <ion-button expand="block" [disabled]="cancelled()" (click)="cancel()">Cancel order</ion-button>
      }

      @if (cancelled()) {
        <ion-item><ion-note>Cancelled. The platform answered 204.</ion-note></ion-item>
      }
    </ion-content>
  `,
})
export class OrderPlacedPage {
  private readonly ordering = inject(OrderingApi);
  private readonly route = inject(ActivatedRoute);

  /**
   * The ONLY reason a cancellation from this screen can truthfully carry.
   *
   * `CANCEL_REASONS` mirrors the whole wire vocabulary
   * (Common.Contracts/Ordering/V1/Commands.cs - `CancelReasons`) and that
   * mirror is right, but four of the five are facts the PLATFORM discovers:
   * out_of_stock and stock_timeout come from the fulfilment saga,
   * payment_declined and payment_timeout from Payments. None of them is a
   * choice a customer makes, and OrderEndpoints.cs stamps every cancellation
   * from this route `CommandOrigin.User` regardless of the code sent.
   *
   * So offering the list would let a customer record "cancelled because
   * payment was declined, origin user" - a statement about an incident that
   * did not happen. It is not cosmetic: the backend's own comment notes that
   * payment_declined and payment_timeout are one dimension value apart on the
   * orders.cancelled metric and a different incident, so a mis-picked code
   * lands in the data operators read during one.
   */
  private static readonly USER_REASON: CancelReason = 'customer_request';

  /**
   * Reactive, not a one-shot `route.snapshot` read. Angular's default
   * `RouteReuseStrategy` compares only `routeConfig` identity — params are
   * ignored — so navigating `placed/A` -> `placed/B` can hand this component
   * the SAME `ActivatedRoute` instance rather than constructing a fresh one.
   * `app.config.ts` now installs `IonicRouteStrategy`, which closes that gap
   * app-wide, but this page does not lean on a fact maintained three files
   * away: `paramMap` keeps emitting on a reused `ActivatedRoute` regardless
   * of which strategy is active (Angular's `advanceActivatedRoute` swaps
   * `snapshot` in place and emits on `paramsSubject` on every reuse, not
   * just a fresh activation), so reading it reactively is correct under
   * either strategy and the page is right on its own terms.
   */
  readonly orderId = toSignal(
    this.route.paramMap.pipe(map((params) => params.get('id') ?? '')),
    { initialValue: this.route.snapshot.paramMap.get('id') ?? '' },
  );

  readonly cancelled = signal(false);
  readonly error = signal<DisplayError | null>(null);

  /** True while a `cancel()` request is outstanding. See `cancel()` below. */
  private readonly cancelling = signal(false);

  readonly alreadyCommitted = computed(() => this.orderId() === ALREADY_COMMITTED);
  readonly canCancel = computed(() => !this.alreadyCommitted() && this.orderId() !== '');

  constructor() {
    // Companion to the reactive `orderId` above: on a reused instance,
    // `cancelled`/`error` are leftovers from the PRIOR order and must not
    // bleed onto the next one's screen — showing "Cancelled. The platform
    // answered 204." for an order that was never touched would be exactly
    // the sentinel-as-real-id failure this branch keeps re-finding, one
    // signal over. Same idiom as `ProductsPage`'s `constructedAtVersion`
    // guard: an `effect()` runs once immediately on top of every signal it
    // reads, so the id seen right here — this construction's own initial
    // value — is remembered and skipped; only a LATER change (a different id
    // landing on this same instance) resets the two signals.
    const constructedForId = this.orderId();
    effect(() => {
      if (this.orderId() === constructedForId) return;
      this.cancelled.set(false);
      this.error.set(null);
    });
  }

  cancel(): void {
    // `CancelOrderRequest` carries no command id — the wire body is
    // `{ reason }` alone — so, unlike checkout's `placeOrder()`, there is no
    // idempotency key here for a duplicate tap to replay under and nothing
    // for `request.in_progress` to demonstrate. Checkout deliberately lets a
    // double-click send two requests, because doing so exercises the real
    // mechanism; here a second tap would just be a second, uncorrelated
    // command, so it is guarded outright rather than left to the domain's
    // own idempotent `Order.Cancel` (harmless on its own, but two concurrent
    // writes to the same order can still surface EF's
    // `request.concurrency_conflict` on the second one).
    if (this.cancelling()) return;
    this.cancelling.set(true);

    this.ordering.cancel(this.orderId(), OrderPlacedPage.USER_REASON).subscribe({
      next: () => {
        this.cancelling.set(false);
        this.error.set(null);
        this.cancelled.set(true);
      },
      error: (failure: HttpErrorResponse) => {
        this.cancelling.set(false);
        // The permission comes from the route's own knowledge of what it
        // needs, not from the response — the 403 deliberately names none.
        this.error.set(mapError(failure, { permission: PERMISSIONS.ordersCancel }));
      },
    });
  }
}
```

- [ ] **Step 3: Correct the comment on the method this page calls**

`src/app/core/api/ordering.api.ts` ends `cancel()`'s doc comment with "so
CANCEL_REASONS is the whole vocabulary and the select is bound to it", written
when this page was planned with a picker. There is no select. The first half of
the sentence is still true and load-bearing — the backend 400s an unknown code
rather than defaulting — so keep it and drop the clause about the select:

```ts
  /**
   * Requires `orders:cancel`. Replies 204. An unknown reason code would be a
   * 400 keyed `Reason` — the backend refuses a code it does not know rather
   * than defaulting, so CANCEL_REASONS is the whole vocabulary and a caller
   * may send nothing outside it. Which of the five a given caller may
   * truthfully send is the caller's own question: the order-placed page
   * answers it with `customer_request` and explains why.
   */
  cancel(orderId: string, reason: CancelReason): Observable<void> {
    const body: CancelOrderRequest = { reason };

    // encodeURIComponent: orderId reaches here from a route param, which
    // Angular has already percent-decoded. A raw '/', '?' or '%' in it would
    // otherwise land in this template literal unescaped and turn into a
    // different path plus a query string rather than a single path segment.
    return this.http.post<void>(`${this.base}/${encodeURIComponent(orderId)}/cancel`, body);
  }
```

- [ ] **Step 4: Run the tests and the boundary check**

`ALREADY_COMMITTED` comes from `@core/commands/command-id` in both this page and the checkout page — never from the other feature. The boundary run below is what proves it.

Run: `npm test -- order-placed && npm test && npm run lint`
Expected: all pass. (`npm test -- boundaries` trips the CLI's project-argument parsing; use
`npm test -- --include='**/boundaries*.spec.ts'` to run that file alone.)

- [ ] **Step 5: Commit**

```bash
git add src/app/features/order-placed src/app/core/api/ordering.api.ts
git commit -m "feat(order-placed): order id, cancellation vocabulary, and the missing read stated"
```

---

## Task 14: Publish page

**Blocked on Task 0's `catalog-write` gateway route for its e2e path.** The unit tests pass without it, because `HttpTestingController` never reaches a gateway.

**Files:**
- Modify: `src/app/features/publish/publish.page.ts`
- Test: `src/app/features/publish/publish.page.spec.ts`

- [ ] **Step 1: Write the failing test**

`src/app/features/publish/publish.page.spec.ts`:

```ts
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CatalogRefresh } from '@core/catalog/catalog-refresh';
import { PublishPage } from './publish.page';

describe('PublishPage', () => {
  let fixture: ComponentFixture<PublishPage>;
  let controller: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [PublishPage],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    });

    fixture = TestBed.createComponent(PublishPage);
    controller = TestBed.inject(HttpTestingController);
    fixture.detectChanges();

    fixture.componentInstance.form.setValue({
      name: 'A widget', thumbnailUrl: '', amount: 12.5, currency: 'EUR',
    });
  });

  afterEach(() => controller.verify());

  it('sends a PublishProductCommand with a null thumbnail when blank', () => {
    fixture.componentInstance.publish();

    const body = controller.expectOne('http://localhost:5000/api/v1/catalog/products').request.body;

    expect(body).toMatchObject({
      name: 'A widget', thumbnailUrl: null, amount: 12.5, currency: 'EUR',
    });
    expect(body.commandId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reuses the commandId across a retried 503', async () => {
    fixture.componentInstance.publish();
    const first = controller.expectOne('http://localhost:5000/api/v1/catalog/products');
    const firstId = first.request.body.commandId;
    first.flush({ title: 'Service Unavailable', status: 503 }, { status: 503, statusText: '' });
    await fixture.whenStable();

    fixture.componentInstance.publish();
    const second = controller.expectOne('http://localhost:5000/api/v1/catalog/products');

    expect(second.request.body.commandId).toBe(firstId);
    second.flush('55555555-5555-5555-5555-555555555555', { status: 200, statusText: 'OK' });
  });

  it('mints a fresh commandId after a success', async () => {
    fixture.componentInstance.publish();
    const first = controller.expectOne('http://localhost:5000/api/v1/catalog/products');
    const firstId = first.request.body.commandId;
    first.flush('55555555-5555-5555-5555-555555555555', { status: 200, statusText: 'OK' });
    await fixture.whenStable();

    expect(fixture.componentInstance.identity.current()).not.toBe(firstId);
    expect(fixture.componentInstance.publishedId()).toBe('55555555-5555-5555-5555-555555555555');
  });

  it('shows field errors from a 400 keyed as the validator keyed them', async () => {
    fixture.componentInstance.publish();
    controller.expectOne('http://localhost:5000/api/v1/catalog/products').flush(
      { status: 400, errors: { Amount: ["'Amount' must be greater than or equal to '0'."] } },
      { status: 400, statusText: 'Bad Request' },
    );
    await fixture.whenStable();

    expect(fixture.componentInstance.error()?.fields).toEqual({
      Amount: ["'Amount' must be greater than or equal to '0'."],
    });
  });

  it('asks the products tab to refresh rather than relying on navigation', async () => {
    const refresh = TestBed.inject(CatalogRefresh);
    const before = refresh.current();

    fixture.componentInstance.publish();
    controller
      .expectOne('http://localhost:5000/api/v1/catalog/products')
      .flush('55555555-5555-5555-5555-555555555555', { status: 200, statusText: 'OK' });
    await fixture.whenStable();

    // ProductsPage is constructed once per app session, so it cannot learn
    // of this publish by being visited. If this assertion fails, a
    // published product is invisible until the app restarts.
    expect(refresh.current()).toBe(before + 1);
  });

  it('publishes a free product, because the backend allows an amount of zero', () => {
    fixture.componentInstance.form.setValue({
      name: 'A free widget', thumbnailUrl: '', amount: 0, currency: 'EUR',
    });

    // Validators.required treats 0 as present (isEmptyInputValue checks
    // null and length, not falsiness), and PublishProductValidator.cs uses
    // GreaterThanOrEqualTo(0). A client that refused 0 would refuse
    // something the platform accepts.
    expect(fixture.componentInstance.form.valid).toBe(true);

    fixture.componentInstance.publish();

    expect(
      controller.expectOne('http://localhost:5000/api/v1/catalog/products').request.body.amount,
    ).toBe(0);
  });

  it('names catalog:write on a 403', async () => {
    fixture.componentInstance.publish();
    controller
      .expectOne('http://localhost:5000/api/v1/catalog/products')
      .flush({ title: 'Forbidden', status: 403 }, { status: 403, statusText: 'Forbidden' });
    await fixture.whenStable();

    expect(fixture.componentInstance.error()?.permission).toBe('catalog:write');
  });
});
```

- [ ] **Step 2: Run and watch it fail, then write the page**

`src/app/features/publish/publish.page.ts`:

```ts
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import {
  IonButton, IonContent, IonHeader, IonInput, IonItem, IonNote, IonTitle, IonToolbar,
} from '@ionic/angular';
import { CatalogApi } from '@core/api/catalog.api';
import { CatalogRefresh } from '@core/catalog/catalog-refresh';
import { PERMISSIONS, PublishProductCommand } from '@core/api/types';
import { CommandIdentity } from '@core/commands/command-id';
import { DisplayError, mapError } from '@core/errors/error-mapper';
import { ErrorBannerComponent } from '@shared/error-banner.component';

/**
 * Spec §5.5, with the same command-id lifecycle as checkout — the backend
 * treats both commands identically, so the client must too.
 *
 * On success it asks CatalogRefresh for a catalogue reload rather than
 * navigating to the products tab and hoping the visit refreshes it — Ionic
 * caches that page, so a visit is not a construction and a construction is
 * the only thing that loads.
 *
 * The gateway routes this POST only once plan Task 0 has landed;
 * `catalog-public` matches GET alone. Until then a real call answers 404 at
 * the edge, which the banner shows as sent.
 */
@Component({
  selector: 'app-publish',
  standalone: true,
  imports: [
    IonButton, IonContent, IonHeader, IonInput, IonItem, IonNote, IonTitle, IonToolbar,
    ReactiveFormsModule, ErrorBannerComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ion-header><ion-toolbar><ion-title>Publish</ion-title></ion-toolbar></ion-header>

    <ion-content>
      <app-error-banner [error]="error()" />

      <form [formGroup]="form" (ngSubmit)="publish()">
        <ion-item><ion-input label="Name" formControlName="name" required></ion-input></ion-item>
        <ion-item><ion-input label="Thumbnail URL" formControlName="thumbnailUrl"></ion-input></ion-item>
        <ion-item>
          <ion-input label="Amount" type="number" formControlName="amount" required></ion-input>
        </ion-item>
        <ion-item><ion-input label="Currency" formControlName="currency" required></ion-input></ion-item>

        <ion-button expand="block" type="submit" [disabled]="form.invalid || identity.isSpent()">
          Publish
        </ion-button>
      </form>

      @if (publishedId(); as id) {
        <ion-item><ion-note>Published as <code>{{ id }}</code>.</ion-note></ion-item>
      }
    </ion-content>
  `,
})
export class PublishPage {
  private readonly catalog = inject(CatalogApi);
  private readonly catalogRefresh = inject(CatalogRefresh);

  readonly identity = new CommandIdentity();

  readonly form = new FormGroup({
    name: new FormControl('', { nonNullable: true, validators: Validators.required }),
    thumbnailUrl: new FormControl('', { nonNullable: true }),
    amount: new FormControl<number | null>(null, { validators: Validators.required }),
    currency: new FormControl('', { nonNullable: true, validators: Validators.required }),
  });

  readonly error = signal<DisplayError | null>(null);
  readonly publishedId = signal<string | null>(null);

  constructor() {
    this.form.valueChanges.subscribe(() => this.identity.onEdit());
  }

  publish(): void {
    const value = this.form.getRawValue();

    const command: PublishProductCommand = {
      commandId: this.identity.current(),
      name: value.name,
      thumbnailUrl: value.thumbnailUrl.trim() === '' ? null : value.thumbnailUrl,
      // The form's required validator guarantees a number here. Sending null
      // would be met with the backend's own NotNull, keyed `Amount` — correct,
      // and still a client bug.
      amount: value.amount!,
      currency: value.currency,
    };

    this.catalog.publish(command).subscribe({
      next: (productId) => {
        this.error.set(null);
        this.publishedId.set(productId);
        this.identity.onSuccess();
        this.form.reset({ name: '', thumbnailUrl: '', amount: null, currency: '' });

        // "On success the products tab refreshes from the first page"
        // (spec §5.5). Navigation cannot deliver that: Ionic caches a tab's
        // page in its stack and hands back the SAME ComponentRef on
        // re-entry (StackController.getExistingView, via
        // IonRouterOutlet.activateWith), so ProductsPage's constructor runs
        // once per app session and a second visit re-shows the first
        // visit's list. Asking explicitly is the only thing that works, and
        // it is why CatalogRefresh exists.
        //
        // And we stay here rather than navigating: the spec asks for a
        // refreshed tab, not a redirect. Staying keeps the returned id in
        // front of the person who just published, keeps a second publish
        // one form away, and avoids leaving a stale "Published as ..." note
        // sitting on this cached page for the user's next visit.
        this.catalogRefresh.request();
      },
      error: (failure: HttpErrorResponse) => {
        const displayed = mapError(failure, { permission: PERMISSIONS.catalogWrite });
        this.error.set(displayed);
        this.identity.onFailure(displayed);
      },
    });
  }
}
```

Run: `npm test -- publish.page`
Expected: PASS, 7 tests.

- [ ] **Step 3: Commit**

```bash
git add src/app/features/publish
git commit -m "feat(publish): product form behind catalog:write with the shared command-id lifecycle"
```

---

## Task 15: Account page

**Files:**
- Modify: `src/app/features/account/account.page.ts`
- Test: `src/app/features/account/account.page.spec.ts`

- [ ] **Step 1: Write the failing test**

`src/app/features/account/account.page.spec.ts`:

```ts
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { AuthService, CurrentUser } from '@core/auth/auth.service';
import { AccountPage } from './account.page';

function mount(user: CurrentUser | null, sessionEndsOnReload: boolean, denied?: string) {
  TestBed.resetTestingModule();
  const signIn = vi.fn(async () => undefined);
  const signOut = vi.fn(async () => undefined);
  // A BehaviorSubject rather than of(): one test pushes a SECOND value
  // through it, which is the only way to exercise a reused component
  // receiving a different `denied` without a fresh construction.
  const queryParams = new BehaviorSubject(convertToParamMap(denied ? { denied } : {}));

  TestBed.configureTestingModule({
    imports: [AccountPage],
    providers: [
      provideRouter([]),
      {
        provide: ActivatedRoute,
        useValue: {
          queryParamMap: queryParams.asObservable(),
          snapshot: { queryParamMap: queryParams.value },
        },
      },
      {
        provide: AuthService,
        useValue: {
          user: () => signal(user),
          sessionEndsOnReload,
          signIn,
          signOut,
          hasPermission: (n: string) => user?.permissions.includes(n) ?? false,
        },
      },
    ],
  });

  const fixture: ComponentFixture<AccountPage> = TestBed.createComponent(AccountPage);
  fixture.detectChanges();
  return { fixture, signIn, signOut, queryParams };
}

const demo: CurrentUser = {
  username: 'demo',
  subject: 's',
  permissions: ['catalog:write', 'orders:write', 'orders:cancel'],
  expiresAt: 0,
};

describe('AccountPage', () => {
  it('offers sign-in when signed out', () => {
    const { fixture, signIn } = mount(null, true);
    fixture.componentInstance.signIn();

    expect(fixture.componentInstance.username()).toBeNull();
    expect(signIn).toHaveBeenCalledOnce();
  });

  it('shows the username and every permission held as a chip', () => {
    const { fixture } = mount(demo, true);

    expect(fixture.componentInstance.username()).toBe('demo');
    expect(fixture.componentInstance.permissions()).toEqual([
      'catalog:write', 'orders:write', 'orders:cancel',
    ]);

    // Spec §5.6 asks for the permissions held AS CHIPS. Asserting the
    // computed alone would pass with the whole template deleted.
    const chips = Array.from(
      fixture.nativeElement.querySelectorAll('ion-chip') as NodeListOf<HTMLElement>,
    ).map((chip) => chip.textContent?.trim());

    expect(chips).toEqual(['catalog:write', 'orders:write', 'orders:cancel']);
    expect(fixture.nativeElement.textContent).toContain('demo');
  });

  it('says plainly that an account with no permissions can write nothing', () => {
    const { fixture } = mount({ ...demo, permissions: [] }, true);

    expect(fixture.nativeElement.querySelectorAll('ion-chip')).toHaveLength(0);
    expect(fixture.nativeElement.textContent).toContain(
      'Every write in this application will answer 403.',
    );
  });

  it('states the web token posture', () => {
    expect(mount(demo, true).fixture.componentInstance.tokenPosture()).toBe(
      'Session ends on reload, no refresh token.',
    );
  });

  it('states the native token posture', () => {
    expect(mount(demo, false).fixture.componentInstance.tokenPosture()).toBe(
      'Refresh token in secure storage, rotated.',
    );
  });

  it('shows an error when sign-in cannot reach the identity provider', async () => {
    // signIn() rejects when discovery is unreachable — WebAuthStrategy retries
    // it, because initCodeFlow() with no loginUrl does nothing at all. A bare
    // `void` here would leave a button that looks broken and says nothing.
    // A bare string, because that is what angular-oauth2-oidc's
    // loadDiscoveryDocument() actually rejects with. Rejecting with an
    // HttpErrorResponse here would make this test agree with an annotation
    // the runtime does not honour, and pass even if mapError still
    // required one.
    signIn.mockRejectedValueOnce('Error loading discovery document');

    fixture.componentInstance.signIn();
    await fixture.whenStable();

    expect(fixture.componentInstance.error()).not.toBeNull();
  });

  it('renders the permission a refused route needed', () => {
    const { fixture } = mount(demo, true, 'catalog:write');

    expect(fixture.componentInstance.denied()).toBe('catalog:write');
    expect(fixture.nativeElement.textContent).toContain('Route refused');
    expect(fixture.nativeElement.querySelector('code')?.textContent).toBe('catalog:write');
  });

  it('follows a later refusal on the same cached instance', async () => {
    // The bug this guards: Account is a tab, Ionic caches its page, and
    // IonicRouteStrategy compares route params rather than query params —
    // so a redirect from permissionGuard reaches an ALREADY CONSTRUCTED
    // component. A snapshot read would still be showing the first value,
    // which for most users is no value at all.
    const { fixture, queryParams } = mount(demo, true, 'catalog:write');

    queryParams.next(convertToParamMap({ denied: 'orders:cancel' }));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.componentInstance.denied()).toBe('orders:cancel');
    expect(fixture.nativeElement.querySelector('code')?.textContent).toBe('orders:cancel');
  });
});
```

- [ ] **Step 2: Run and watch it fail, then write the page**

`src/app/features/account/account.page.ts`:

```ts
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { map } from 'rxjs';
import {
  IonButton, IonChip, IonContent, IonHeader, IonItem, IonLabel, IonNote, IonTitle, IonToolbar,
} from '@ionic/angular';
import { AuthService } from '@core/auth/auth.service';
import { DisplayError, mapError } from '@core/errors/error-mapper';
import { ErrorBannerComponent } from '@shared/error-banner.component';

/** Spec §5.6. */
@Component({
  selector: 'app-account',
  standalone: true,
  imports: [
    IonButton, IonChip, IonContent, IonHeader, IonItem, IonLabel, IonNote, IonTitle,
    IonToolbar, ErrorBannerComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ion-header><ion-toolbar><ion-title>Account</ion-title></ion-toolbar></ion-header>

    <ion-content>
      <app-error-banner [error]="error()" />

      @if (denied(); as permission) {
        <ion-item>
          <ion-label>
            <h2>Route refused</h2>
            <ion-note>That page needs <code>{{ permission }}</code>, which this account does not hold.</ion-note>
          </ion-label>
        </ion-item>
      }

      @if (username(); as name) {
        <ion-item><ion-label><h2>{{ name }}</h2></ion-label></ion-item>

        <ion-item>
          <ion-label>
            <h3>Permissions</h3>
            @if (permissions().length === 0) {
              <ion-note>None. Every write in this application will answer 403.</ion-note>
            }
            @for (permission of permissions(); track permission) {
              <ion-chip>{{ permission }}</ion-chip>
            }
          </ion-label>
        </ion-item>

        <ion-button expand="block" (click)="signOut()">Sign out</ion-button>
      } @else {
        <ion-button expand="block" (click)="signIn()">Sign in</ion-button>
      }

      <ion-item><ion-note>{{ tokenPosture() }}</ion-note></ion-item>
    </ion-content>
  `,
})
export class AccountPage {
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);

  private readonly currentUser = this.auth.user();

  readonly username = computed(() => this.currentUser()?.username ?? null);
  readonly permissions = computed(() => this.currentUser()?.permissions ?? []);
  /**
   * Read reactively, NOT from `route.snapshot`, and this page is the one
   * where that matters most.
   *
   * permissionGuard sends a refused navigation here as
   * `/tabs/account?denied=<permission>`. Account is a TAB: Ionic caches its
   * page in the tab stack and hands back the same ComponentRef on re-entry,
   * so this constructor runs once per app session — and a user who has
   * opened Account even once would afterwards be redirected here by the
   * guard and shown nothing at all.
   *
   * IonicRouteStrategy does not rescue this the way it rescues
   * order-placed's `:id`: its shouldReuseRoute compares `future.params`
   * against `curr.params`, which are ROUTE params. Query params are not
   * compared, so a change from `/tabs/account` to
   * `/tabs/account?denied=catalog:write` reuses the component by design.
   * Subscribing is the only thing that sees it.
   */
  readonly denied = toSignal(
    this.route.queryParamMap.pipe(map((params) => params.get('denied'))),
    { initialValue: this.route.snapshot.queryParamMap.get('denied') },
  );

  private readonly errorState = signal<DisplayError | null>(null);
  readonly error = this.errorState.asReadonly();

  /**
   * The platform's token posture in one line. Both sentences are true
   * statements about a realm decision rather than reassurance: `web-app`
   * carries `use.refresh.tokens: "false"`, so the browser genuinely cannot
   * survive a reload, and saying so is more useful than a silent sign-out.
   */
  readonly tokenPosture = computed(() =>
    this.auth.sessionEndsOnReload
      ? 'Session ends on reload, no refresh token.'
      : 'Refresh token in secure storage, rotated.',
  );

  signIn(): void {
    this.errorState.set(null);

    // .catch(), not a bare `void` — and this button matters more than the
    // cart's, because it is the application's primary sign-in affordance.
    // signIn() rejects when the identity provider is unreachable:
    // WebAuthStrategy retries the discovery document there, since
    // initCodeFlow() with no loginUrl returns having done nothing instead of
    // navigating. Swallowed, that leaves a Sign in button which looks broken
    // and says nothing — the same failure the initializer fix removed from
    // the shell, reappearing on the one screen whose job is to explain the
    // session.
    // Untyped on purpose. `loadDiscoveryDocument()` rejects with a bare
    // STRING, not an HttpErrorResponse — annotating it as one is a claim
    // the runtime does not honour, which is why mapError takes `unknown`
    // and returns a retry kind for anything it does not recognise.
    this.auth.signIn().catch((failure: unknown) => {
      this.errorState.set(mapError(failure));
    });
  }

  signOut(): void {
    void this.auth.signOut();
  }
}
```

Run: `npm test -- account.page`
Expected: PASS, 9 tests.

- [ ] **Step 3: Run the whole suite**

Run: `npm test && npm run lint && npm run build`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/app/features/account
git commit -m "feat(account): identity, permissions as chips, and the platform token posture"
```

---
## Task 16: Playwright smoke

Spec §7. One smoke against the backend's Compose stack. It is never skipped silently: without the stack it fails on connection, matching the backend's rule that a skip fails open.

**Blocked on Task 0** for its publish half only. Write the whole file; the `browser`-user half passes either way.

**Files:**
- Create: `e2e/smoke.spec.ts`, `playwright.config.ts`
- Modify: `package.json` — an `e2e` script

- [ ] **Step 1: Write the Playwright config**

`playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // No retries. A flaky smoke against a real stack is a fact about the stack,
  // and hiding it behind a retry is how a broken platform passes CI.
  retries: 0,
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run start',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
  },
});
```

- [ ] **Step 2: Write the smoke**

`e2e/smoke.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

const GATEWAY = 'http://localhost:5000';
const KEYCLOAK = 'http://localhost:8080';

/**
 * Requires Docker and the backend checkout. Without the stack this fails on
 * connection rather than skipping — the backend's own rule is that a skip
 * fails open, and a smoke that quietly passes with nothing running is worse
 * than no smoke.
 */
test.beforeAll(async ({ request }) => {
  const health = await request.get(`${GATEWAY}/health/ready`);
  expect(
    health.ok(),
    `The gateway is not answering at ${GATEWAY}. Start the backend's Compose stack first.`,
  ).toBe(true);
});

async function signIn(page: import('@playwright/test').Page, username: string, password: string) {
  await page.goto('/tabs/account');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(new RegExp(`^${KEYCLOAK}`));

  await page.getByLabel(/username|email/i).fill(username);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole('button', { name: /sign in|log in/i }).click();

  await page.waitForURL(/localhost:5173/);
}

test('demo browses, quotes, orders and cancels', async ({ page }) => {
  await signIn(page, 'demo', 'demo');

  await expect(page.getByText('demo')).toBeVisible();
  await expect(page.getByText('catalog:write')).toBeVisible();

  // Browse a page of products and add two.
  await page.getByRole('tab', { name: 'Products' }).click();
  const addButtons = page.getByRole('button', { name: 'Add' });
  await expect(addButtons.first()).toBeVisible();
  await addButtons.nth(0).click();
  await addButtons.nth(1).click();

  // Quote.
  await page.getByRole('tab', { name: 'Cart' }).click();
  await page.getByRole('button', { name: 'Get quote' }).click();
  await expect(page.getByText(/Total/)).toBeVisible();

  // Place.
  await page.getByRole('button', { name: 'Checkout' }).click();
  await page.getByLabel('Line 1').fill('1 Example Street');
  await page.getByLabel('City').fill('Doha');
  await page.getByLabel('Postal code').fill('00000');
  await page.getByLabel('Country').fill('QA');
  await page.getByRole('button', { name: 'Place order' }).click();

  await expect(page.getByText('Order')).toBeVisible();
  await expect(
    page.getByText('The platform exposes no endpoint that reads an order back'),
  ).toBeVisible();

  // Cancel with the preselected reason.
  await page.getByRole('button', { name: 'Cancel order' }).click();
  await expect(page.getByText('The platform answered 204.')).toBeVisible();
});

test('demo publishes a product', async ({ page }) => {
  // Requires the gateway's catalog-write route (plan Task 0). Before it lands
  // this fails with the edge's 404, which is the accurate result.
  await signIn(page, 'demo', 'demo');

  await page.getByRole('tab', { name: 'Publish' }).click();
  await page.getByLabel('Name').fill(`Smoke ${Date.now()}`);
  await page.getByLabel('Amount').fill('9.99');
  await page.getByLabel('Currency').fill('EUR');
  await page.getByRole('button', { name: 'Publish' }).click();

  await expect(page.getByRole('tab', { name: 'Products' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test('browser holds no permissions: the publish tab is absent and the route refuses', async ({ page }) => {
  await signIn(page, 'browser', 'browser');

  await expect(page.getByText('browser')).toBeVisible();
  await expect(page.getByText('None. Every write in this application will answer 403.')).toBeVisible();

  // The tab hides…
  await expect(page.getByRole('tab', { name: 'Publish' })).toHaveCount(0);

  // …and a direct navigation is refused, which is the other half. A hidden
  // button and a refused route are two different facts.
  await page.goto('/tabs/publish');
  await expect(page).toHaveURL(/denied=catalog%3Awrite/);
  await expect(page.getByText('That page needs')).toBeVisible();
});
```

- [ ] **Step 3: Add the script**

In `package.json`:

```json
"e2e": "playwright test"
```

- [ ] **Step 4: Run it against the real stack**

```bash
(cd ../blueprint-backend && docker compose -f deploy/compose/docker-compose.yml up -d --wait)
npx playwright install --with-deps chromium
npm run e2e
```

Expected: the first and third tests PASS. The second PASSES only if Task 0 has merged; without it, it fails on the gateway's 404 — which is the accurate result and not a reason to skip the test.

- [ ] **Step 5: Commit**

```bash
git add e2e playwright.config.ts package.json
git commit -m "test(e2e): smoke covering both realm users against the Compose stack"
```

---

## Task 17: CI and the architecture document

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `docs/client-architecture.md`

- [ ] **Step 1: Write the web half of the workflow**

`.github/workflows/ci.yml`. Steps 3 and 4 of spec §8 (Android, iOS) are added in Task 21; this is the web job plus the e2e job.

```yaml
name: ci

on:
  push:
  pull_request:

jobs:
  web:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm test
      - run: npm run build

  e2e:
    runs-on: ubuntu-latest
    # Needs Docker and the backend checkout. Not continue-on-error: a smoke
    # that is allowed to fail is a smoke nobody reads.
    steps:
      - uses: actions/checkout@v4
      - uses: actions/checkout@v4
        with:
          repository: alexander-shamray/dotnet-ddd-blueprint
          path: blueprint-backend
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - run: npx playwright install --with-deps chromium

      - name: Start the platform
        working-directory: blueprint-backend
        run: docker compose -f deploy/compose/docker-compose.yml up -d --wait

      - name: Wait for the gateway
        run: |
          for i in $(seq 1 60); do
            curl -fsS http://localhost:5000/health/ready && exit 0
            sleep 5
          done
          echo "The gateway never became ready." >&2
          exit 1

      - run: npm run e2e

      - if: always()
        working-directory: blueprint-backend
        run: docker compose -f deploy/compose/docker-compose.yml logs --no-color > ../compose.log

      - if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: failure-diagnostics
          path: |
            compose.log
            test-results/
```

- [ ] **Step 2: Write `docs/client-architecture.md`**

One section per backend decision this client can observe, each naming where it shows up here. Cover, at minimum:

1. **Anonymous listing.** `catalog-public` names YARP's reserved `anonymous`; `GetProducts` says `AllowAnonymous`. So Products is the landing tab and works signed out.
2. **Five-minute token, no refresh token on the web.** `accessTokenLifespan: 300` and `web-app`'s `use.refresh.tokens: "false"`. Hence in-memory tokens, a silent code flow at 75% of `exp`, and the account page's one-line statement.
3. **Permissions are claims.** The `commerce-api` scope's `permission` mapper. Hence `hasPermission`, the hidden fourth tab, the route guard, and the 403 banner that names the permission from the route rather than from the response.
4. **Idempotency by `commandId`.** `IdempotencyBehavior` keys on subject, operation and id. Hence `CommandIdentity`, minted per form, held across a failure, released on success or on an edit after a validation refusal.
5. **Three 409s, not one.** The `code` extension and why a client that switched on `detail` would break on a reword.
6. **200, not 201.** `ToHttpResult` and the absence of a `Location` header — because there is no endpoint to follow one to.
7. **No order read.** `OrderingPermissions.cs` on why `orders:read` does not exist. Hence the sentence on the placed page and the absence of polling.
8. **The BFF states the gap.** `QuoteResponse.Unpriced` is named rather than omitted; the cart marks those lines and blocks checkout.
9. **The total is the BFF's.** Two places computing a total is two places to get rounding wrong.
10. **`Retry-After` and CORS.** Why the correlation id comes from the body and the countdown may be a fallback, and what Task 0 changes.
11. **The gateway routes GET for catalog.** Why Publish needed a route, and why the client did not simply call `catalog-api` directly — the gateway is the only host the client calls.
12. **Deviations from the spec.** The four corrections above, and `ng new` + `ng add @ionic/angular` in place of `ionic start`.

- [ ] **Step 3: Verify the workflow parses**

Run: `npx --yes @action-validator/cli --verbose .github/workflows/ci.yml` (or push the branch and read the run).
Expected: valid.

- [ ] **Step 4: Commit**

```bash
git add .github docs/client-architecture.md
git commit -m "ci: lint, test, build and the Compose-backed smoke; document the client's arguments"
```

**Phase A is complete here.** A working web client, every endpoint, the full error table, unit and component tests, an e2e smoke and CI.

---

## Task 18: Capacitor and the Android project

**Files:**
- Create: `capacitor.config.ts`, `android/` (committed)
- Modify: `package.json`

**Interfaces:**
- Produces: `npx cap sync android` succeeds; `android/` builds a debug APK.

- [ ] **Step 1: Initialise Capacitor**

```bash
# @capacitor/core and @capacitor/preferences are already installed and pinned
# by Task 7, which is where the cart's persistence first needed them. Do not
# reinstall or re-pin them here.
npm install --save-exact @capacitor/app@8.1.1 @capacitor/browser@8.0.4
npm install --save-dev --save-exact @capacitor/cli@8.5.1
npx cap init "Blueprint" "dev.ashamray.blueprint" --web-dir=dist/blueprint-frontend/browser
npm install --save-exact @capacitor/android@8.5.1
npx cap add android
```

- [ ] **Step 2: Register the custom scheme**

`capacitor.config.ts`:

```ts
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'dev.ashamray.blueprint',
  appName: 'Blueprint',
  webDir: 'dist/blueprint-frontend/browser',
  // The custom scheme the system browser returns to after the authorization
  // code flow (spec §4.2). It must match the mobile-app realm client's
  // redirectUris exactly — Keycloak compares the string.
  plugins: {
    App: { launchUrl: 'blueprint://auth/callback' },
  },
};

export default config;
```

In `android/app/src/main/AndroidManifest.xml`, add an intent filter to the main activity:

```xml
<intent-filter>
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="blueprint" android:host="auth" />
</intent-filter>
```

- [ ] **Step 3: Build and sync**

```bash
npm run build
npx cap sync android
(cd android && ./gradlew assembleDebug)
```

Expected: `BUILD SUCCESSFUL`, an APK under `android/app/build/outputs/apk/debug/`.

- [ ] **Step 4: Commit the native project**

```bash
git add capacitor.config.ts android package.json package-lock.json
git commit -m "feat(native): Capacitor Android project with the blueprint:// auth scheme"
```

---

## Task 19: Native auth strategy

**Blocked on Task 0's `mobile-app` realm client.**

**Files:**
- Create: `src/app/core/auth/native-auth.strategy.ts`
- Modify: `src/app/core/auth/auth.providers.ts`
- Test: `src/app/core/auth/native-auth.strategy.spec.ts`

**Interfaces:**
- Consumes: `AuthService`, `decodeUser` (Task 5); `environment.auth.nativeClientId`, `.nativeRedirectUri` (Task 2).
- Produces: `NativeAuthStrategy extends AuthService` with `sessionEndsOnReload = false`.

- [ ] **Step 1: Write the failing test**

`src/app/core/auth/native-auth.strategy.spec.ts`. Four behaviours matter and each is a spec §4.2 sentence:

```ts
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeAuthStrategy, SECURE_STORAGE, SYSTEM_BROWSER } from './native-auth.strategy';

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'RS256' })}.${b64(payload)}.sig`;
}

describe('NativeAuthStrategy', () => {
  const store = new Map<string, string>();
  const secure = {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => void store.set(k, v)),
    remove: vi.fn(async (k: string) => void store.delete(k)),
  };
  const browser = { open: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
  let strategy: NativeAuthStrategy;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    TestBed.configureTestingModule({
      providers: [
        NativeAuthStrategy,
        { provide: SECURE_STORAGE, useValue: secure },
        { provide: SYSTEM_BROWSER, useValue: browser },
      ],
    });

    strategy = TestBed.inject(NativeAuthStrategy);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('opens the SYSTEM browser, never a web view', async () => {
    await strategy.signIn();

    const url = browser.open.mock.calls[0][0].url as string;
    expect(url).toContain('http://localhost:8080/realms/commerce/protocol/openid-connect/auth');
    expect(url).toContain('client_id=mobile-app');
    expect(url).toContain('code_challenge_method=S256');
    expect(url).toContain(encodeURIComponent('blueprint://auth/callback'));
  });

  it('keeps the access token in memory and the refresh token in secure storage', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: jwt({ preferred_username: 'demo', sub: 's', exp: 1_800_000_300 }),
        refresh_token: 'refresh-1',
      }),
    });

    await strategy.signIn();
    await strategy.handleCallback('blueprint://auth/callback?code=abc&state=' + strategy.pendingState());

    expect(strategy.accessToken()).not.toBeNull();
    // Secure storage, not Preferences: the refresh token is a credential.
    expect(secure.set).toHaveBeenCalledWith('blueprint.refresh', 'refresh-1');
    expect(store.get('blueprint.refresh')).toBe('refresh-1');
  });

  it('replaces the stored refresh token on every renewal, because rotation is on', async () => {
    store.set('blueprint.refresh', 'refresh-1');
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: jwt({ preferred_username: 'demo', sub: 's', exp: 1_800_000_300 }),
        refresh_token: 'refresh-2',
      }),
    });

    await strategy.renewNow();

    expect(store.get('blueprint.refresh')).toBe('refresh-2');
  });

  it('signs out when a rotated token is refused', async () => {
    store.set('blueprint.refresh', 'reused');
    fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({}) });

    await strategy.renewNow();

    expect(strategy.accessToken()).toBeNull();
    expect(store.has('blueprint.refresh')).toBe(false);
  });

  it('revokes the refresh token at Keycloak before clearing storage', async () => {
    store.set('blueprint.refresh', 'refresh-1');
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });

    await strategy.signOut();

    expect(fetchMock.mock.calls[0][0]).toContain('/protocol/openid-connect/revoke');
    expect(store.has('blueprint.refresh')).toBe(false);
  });

  it('says the session survives a reload, because the token is stored', () => {
    expect(strategy.sessionEndsOnReload).toBe(false);
  });
});
```

- [ ] **Step 2: Write the strategy**

`src/app/core/auth/native-auth.strategy.ts`. Structure it so the two platform capabilities are injected — `SECURE_STORAGE` wrapping `@aparajita/capacitor-secure-storage` and `SYSTEM_BROWSER` wrapping `@capacitor/browser` — so the tests above run without a device. Implement:

- `signIn()` — generate a 32-byte `code_verifier` and its S256 challenge and a random `state`, hold both in memory only, build the authorization URL from `environment.auth.issuer` with `client_id=mobile-app`, `response_type=code`, `redirect_uri=blueprint://auth/callback`, `scope`, `code_challenge`, `code_challenge_method=S256`, `state`, and open it in the **system browser**. Never a web view: a web view is a browser the application controls, which is the whole property a system browser has and it does not.
- `handleCallback(url)` — invoked from `@capacitor/app`'s `appUrlOpen`. Compare `state` against the pending value and refuse a mismatch. Exchange the code at the token endpoint with the verifier. Adopt the access token in memory; write `refresh_token` to secure storage under `blueprint.refresh`.
- `renewNow()` — POST `grant_type=refresh_token` with the stored token. On success, replace the stored token, because rotation is on at the realm and the old one is now dead. On failure, clear both and require an interactive sign-in: a rotated token that Keycloak refused is a token that cannot be recovered by retrying.
- Schedule `renewNow()` at 75% of the access token's lifetime read from `exp`, exactly as the web strategy does.
- `signOut()` — POST the refresh token to the revocation endpoint first, then clear memory and secure storage. Revoking after clearing would leave a live token at the realm with nothing left to revoke it with.
- `sessionEndsOnReload = false`.

- [ ] **Step 3: Wire the factory**

In `auth.providers.ts`, replace the unconditional `useExisting` Task 5 left with the platform test — this is the moment the second arm becomes real:

```ts
    WebAuthStrategy,
    NativeAuthStrategy,
    {
      provide: AuthService,
      useFactory: () =>
        Capacitor.isNativePlatform() ? inject(NativeAuthStrategy) : inject(WebAuthStrategy),
    },
    provideAppInitializer(() => inject(AuthService).initialize()),
```

The initialiser is unchanged: `initialize()` is on the interface, so it calls whichever strategy the factory chose without a cast and without asking. This factory is the only place in the application that asks which platform it is on (spec §4).

- [ ] **Step 4: Run the tests**

Run: `npm test -- native-auth.strategy && npm test`
Expected: PASS, 6 new tests, whole suite green.

- [ ] **Step 5: Commit**

```bash
git add src/app/core/auth
git commit -m "feat(auth): native PKCE through the system browser with rotated refresh tokens"
```

---

## Task 20: Native verification on a device or emulator

- [ ] **Step 1: Point the emulator at the host stack**

An Android emulator reaches the host at `10.0.2.2`, not `localhost`. Add `src/app/core/config/environment.android.ts` with `gatewayBaseUrl: 'http://10.0.2.2:5000'` and `issuer: 'http://10.0.2.2:8080/realms/commerce'`, and add `10.0.2.2:5173`-equivalent origins to the backend's CORS if you serve the web build; for a packaged Capacitor build the origin is `https://localhost`, which the gateway must also admit — add it to `Cors__Origins__1` locally while testing, and note in `client-architecture.md` that a packaged native build is a different origin from the dev server.

- [ ] **Step 2: Run the round trip**

```bash
npm run build && npx cap sync android && npx cap run android
```

Walk the smoke by hand: sign in through the system browser, confirm the return on `blueprint://auth/callback`, browse, quote, order, cancel. Confirm the cart survives a force-stop and relaunch.

- [ ] **Step 3: Commit any fixes**

```bash
git add -A && git commit -m "fix(native): host origins and callback handling on Android"
```

---

## Task 21: iOS project and the native CI jobs

- [ ] **Step 1: Generate the iOS project**

```bash
npm install --save-exact @capacitor/ios@8.5.1
npx cap add ios
```

Generated on Windows, built on a Mac (spec §10). Add the URL scheme to `ios/App/App/Info.plist`:

```xml
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLSchemes</key>
    <array><string>blueprint</string></array>
  </dict>
</array>
```

- [ ] **Step 2: Add steps 3 and 4 of spec §8 to CI**

Append to `.github/workflows/ci.yml`:

```yaml
  android:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '21'
      - run: npm ci
      - run: npm run build
      - run: npx cap sync android
      - run: ./gradlew assembleDebug
        working-directory: android

  ios-config:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - run: npm run build
      # A configuration check only. The compile lives in the disabled job
      # below; enabling it is one line and costs a macOS runner minute per
      # push, which is the reason it is off rather than an oversight.
      - run: npx cap sync ios

  # ios-build:
  #   runs-on: macos-latest
  #   steps:
  #     - uses: actions/checkout@v4
  #     - uses: actions/setup-node@v4
  #       with: { node-version-file: .nvmrc, cache: npm }
  #     - run: npm ci && npm run build && npx cap sync ios
  #     - run: xcodebuild -workspace ios/App/App.xcworkspace -scheme App -sdk iphonesimulator build
```

- [ ] **Step 3: Verify**

Run: `npm run build && npx cap sync ios`
Expected: succeeds on Windows (sync is a file copy and a config write; it does not compile).

- [ ] **Step 4: Commit**

```bash
git add ios .github/workflows/ci.yml package.json package-lock.json
git commit -m "feat(native): iOS project and the Android and iOS CI jobs"
```

---

## Self-Review

Run against the spec after the plan was written.

**Spec coverage.** §1 properties → the citation rule in Global Constraints, the boundary test in Task 1, the platform factory in Task 5. §2 endpoints → Task 6, all five, with the four corrections recorded above. §2.1 facts → Task 8 (idempotency), Task 5 (five-minute token, silent renewal), Tasks 5/9/15 (claims), Task 1 (port 5173). §3 shape → the File Structure table; boundaries in Task 1. §4 identity → Task 5 (web), Task 19 (native), Task 5 (shared). §5 screens → Tasks 10–15, one each. §6 errors → Task 4, one test per row plus the two extra 409 kinds. §7 testing → unit tests in every task, component tests in Tasks 10–15, e2e in Task 16, boundaries in Task 1. §8 CI → Tasks 17 and 21, all five numbered steps. §9 backend PR → Task 0, extended with the catalog route and the CORS header. §11 versions → Global Constraints, every pin verified published.

**Known gaps, stated rather than hidden.**
- Spec §7 asks for a component test per page "driving the page through the mapped errors". Tasks 10–15 test one or two error paths per page, not all eleven kinds; the exhaustive per-kind coverage lives in Task 4's mapper tests, which is where the mapping is decided. If fuller page-level coverage is wanted, it is an addition to each page task rather than a new one.
- Task 19's strategy is specified behaviourally rather than as a finished code block, because its shape depends on what `@aparajita/capacitor-secure-storage@8.0.0` exposes on the installed version. Its six tests are complete and are the contract.
- Task 20 flags that a packaged Capacitor build's origin is `https://localhost`, which the gateway's CORS list does not admit. That is a real deployment question the spec does not cover; it is called out where it bites rather than resolved here.

**Type consistency.** `DisplayError`/`ErrorKind` (Task 4) are used unchanged in Tasks 8, 10–15. `CartLine` (Task 7) is used in Tasks 11–12. `CommandIdentity` (Task 8) exposes `current`, `isSpent`, `onFailure`, `onEdit`, `onSuccess`, and Tasks 12 and 14 call exactly those. `AuthService`'s five members plus `sessionEndsOnReload` (Task 5) are what Tasks 9, 11 and 15 call. `ALREADY_COMMITTED` is defined in Task 12 and moved to `@core/commands/command-id` in Task 13's boundary note before either page ships.
