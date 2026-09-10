# Blueprint frontend — design

**A reference client for `dotnet-ddd-blueprint`: one Angular codebase that runs
as a web app, an Android app and an iOS app, and exercises every endpoint the
backend exposes.**

| | |
|---|---|
| **Status** | Approved design, 2026-09-10. Implementation plan follows. |
| **Backend** | `alexander-shamray/dotnet-ddd-blueprint`, checked out beside this repository at `../blueprint-backend` |
| **Toolkit** | Angular 22.1, Ionic 9.0, Capacitor 8.5, TypeScript, Vitest, Playwright |
| **Identity** | Keycloak realm `commerce`; PKCE code flow; `web-app` on the web, `mobile-app` on Android and iOS |
| **Prerequisite** | Node 22.22 or newer (Angular 22's CLI floor). The workstation has Node 20 and must upgrade first |

## 1. Purpose

The backend is a reference architecture whose blueprint and code are one
artefact in two representations. This repository is that artefact's client: a
thin, well-documented application whose only job is to call the platform the
way the blueprint says a client should. It is not a storefront and not an admin
tool. Where the backend makes a decision that a client can observe — an
anonymous route, a five-minute token, an idempotent command, a stated
cancellation vocabulary — this client shows the decision rather than papering
over it.

Three properties follow, and each design choice below is argued against them:

1. **Every endpoint the backend exposes is reachable from every platform.**
   A mobile shell that can only browse is not a client.
2. **Nothing is invented on the client that the backend owns.** Error text,
   permission names, reason codes and DTO shapes are cited from the backend by
   file and symbol, never restated in the client's own words.
3. **One codebase.** Platform differences are isolated behind interfaces; a
   screen never asks which platform it is on.

## 2. What the backend exposes

The gateway (`Gateway.Api`, port 5000 under Compose) is the only host the
client calls. The paths below are the gateway's; the gateway strips the first
segment before forwarding.

| Method and path | Host | Auth at the edge | Body or query | Reply |
|---|---|---|---|---|
| `GET /api/v1/catalog/products?cursor=&limit=20` | Catalog | anonymous, rate limited | — | `CursorPage<ProductSummaryDto>`: `{ items: [...], nextCursor: string \| null }` |
| `POST /api/v1/catalog/products` | Catalog | `catalog:write` | `PublishProductCommand`: `{ commandId, name, thumbnailUrl?, amount, currency }` | `201` with the product id |
| `GET /bff/v1/checkout/quote?productId=&productId=&currency=` | Web.Bff | authenticated | repeated `productId`, one `currency` | `QuoteResponse`: `{ currency, lines: [{ productId, name, amount }], total, unpriced: [guid] }` |
| `POST /api/v1/orders` | Ordering | `orders:write` | `PlaceOrderCommand`: `{ commandId, items: [{ productId, quantity }], shippingAddress: { line1, line2?, city, postalCode, country }, currency }` | `201` with the order id |
| `POST /api/v1/orders/{id}/cancel` | Ordering | `orders:cancel` | `{ reason }`, one of `out_of_stock`, `stock_timeout`, `payment_declined`, `payment_timeout`, `customer_request` | `204` |

There is no endpoint that reads an order back, and the client says so on the
one screen where a reader would expect one (§5.4).

Owners, for the citation rule in §1: `ProductSummaryDto` and
`PublishProductCommand` in `Catalog.Application`; `CursorPage<T>` in
`Common.Application`; `PlaceOrderCommand`, `PlaceOrderItem`, `AddressDto` and
`CancellationReasons` in `Ordering.Application`; the reason codes in
`Common.Contracts.Ordering.V1.CancelReasons`; `QuoteResponse` and `QuoteLine`
in `Web.Bff.Endpoints`; the permission names in `CatalogPermissions` and
`OrderingPermissions`; the status mapping in `Common.Web.ResultExtensions`.

### 2.1 Facts the client must honour

- **Commands are idempotent by `commandId`.** The backend keys
  `IdempotencyBehavior` on subject, operation and `commandId`. A retry with
  the same id is a replay, not a duplicate; a concurrent second request with
  the same id is refused with 409. The client therefore mints the id once per
  form, not once per click (§5.3).
- **The access token lives five minutes and the browser gets no refresh
  token.** `web-app` carries `use.refresh.tokens: "false"` by decision. The
  web strategy renews through a silent code flow; it does not, and cannot, use
  a refresh token (§4.1).
- **Permissions are claims, not roles.** The `commerce-api` client scope maps
  a `permission` claim; `RequireClaim` reads it. The client reads the same
  claim for guards and button visibility, and treats a 403 as the backend's
  answer rather than a bug (§4.3).
- **CORS admits `http://localhost:5173` in development.** The Angular dev
  server is configured to serve on 5173 rather than its default 4200, because
  the backend's Compose file and the realm's `webOrigins` both name 5173 and a
  client should not require the backend to change for it to run.

## 3. Repository and application shape

One repository, `alexander-shamray/blueprint-frontend`, default branch `main`,
one Angular standalone application generated by the Ionic CLI, with Capacitor's
native projects committed.

```
blueprint-frontend/
  src/app/
    core/
      config/          environment.ts, environment.development.ts:
                       gateway base URL, Keycloak authority, client id per platform
      api/             catalog.api.ts, ordering.api.ts, checkout.api.ts, types.ts
      auth/            auth.service.ts (interface + factory), web-auth.strategy.ts,
                       native-auth.strategy.ts, auth.interceptor.ts,
                       permission.guard.ts, current-user.ts
      errors/          problem-details.ts, error-mapper.ts
      cart/            cart.store.ts (signals), cart.persistence.ts (Capacitor Preferences)
    features/
      products/        products.page.ts — list, infinite scroll, add to cart
      cart/            cart.page.ts — lines, quantities, quote
      checkout/        checkout.page.ts — address, currency, place order
      order-placed/    order-placed.page.ts — id, cancel with reason
      publish/         publish.page.ts — publish product form
      account/         account.page.ts — sign in/out, username, permissions
    app.routes.ts, app.component.ts, tabs
  android/             Capacitor Android project, committed
  ios/                 Capacitor iOS project, generated on Windows, built on a Mac
  e2e/                 Playwright smoke test
  docs/
    client-architecture.md   how each backend decision shows up in this client
    superpowers/specs/       this document and its successors
  .github/workflows/ci.yml
  .gitattributes             `* text=auto eol=lf`
```

**Boundaries.** `core/api` knows HTTP and the wire types and nothing about
screens. `core/auth` knows tokens and claims and nothing about HTTP calls to
the platform beyond attaching a header. `features/*` know their page and the
two core services they use. A feature never imports another feature; the cart
store is in core because two features share it. The rule is checked by an
ESLint `no-restricted-imports` rule per feature folder rather than trusted.

**Types.** `core/api/types.ts` hand-writes the shapes in §2, one interface per
backend record, each with a one-line comment naming the backend file and
symbol it mirrors. Generation from the Catalog and Ordering OpenAPI documents
was considered and deferred: the BFF publishes no document, six endpoints do
not pay for the tooling, and a citing comment is enough for grep to find drift
in either direction.

**Cart.** The backend has no cart, so the cart is client state: a signals
store of `{ productId, name, amount, currency, quantity }` lines, persisted
through Capacitor Preferences on every change and restored at startup. Prices
in the cart are the listing prices and are labelled as such; the quote is the
price that counts.

## 4. Identity

One `AuthService` interface — `signIn()`, `signOut()`, `accessToken()`,
`user()`, `hasPermission(name)` — with two implementations. A factory picks
one at startup from Capacitor's `isNativePlatform()`; nothing else in the
application asks which platform it is on.

### 4.1 Web strategy

- Library: `angular-oauth2-oidc` 22.
- Client: the realm's existing `web-app`. Authorization code with PKCE S256,
  redirect to `http://localhost:5173/` in development; production origins are
  a deployment concern and are read from `environment.ts`.
- Tokens are held in memory only. Nothing is written to `localStorage` or
  `sessionStorage`. A page reload signs the user out, and the account page
  says so, because that is the honest consequence of the realm's decision.
- **Renewal.** The realm issues no refresh token, so the strategy schedules a
  silent code-flow renewal in a hidden iframe at 75% of the access token's
  lifetime, using `prompt=none`. If Keycloak answers `login_required` the
  session is gone and the next protected action prompts an interactive
  sign-in. The five-minute lifetime is read from the token's `exp` claim, not
  hard-coded, so a realm change moves the schedule without a client release.
- Sign-out ends the Keycloak session through the end-session endpoint and
  clears memory.

### 4.2 Native strategy

- Client: a new `mobile-app` public client, added by the backend PR in §9.
- Flow: authorization code with PKCE S256 through the **system browser**
  (`@capacitor/browser`), never a web view, returning on the custom scheme
  `blueprint://auth/callback`, which `@capacitor/app`'s `appUrlOpen` event
  delivers to the strategy. The code verifier is generated per attempt and
  never leaves memory.
- Tokens: the access token is held in memory. The refresh token is stored in
  platform secure storage — Android Keystore-backed and iOS Keychain — through
  `@aparajita/capacitor-secure-storage`, and never in Preferences. Rotation is on
  at the realm, so each refresh replaces the stored token and a reused one is
  refused by Keycloak, which the strategy treats as sign-out.
- Renewal: refresh at 75% of lifetime; on a refresh failure, clear both tokens
  and require an interactive sign-in.
- Sign-out revokes the refresh token at Keycloak's revocation endpoint before
  clearing storage.

### 4.3 Shared

- `auth.interceptor.ts` attaches `Authorization: Bearer` to requests whose URL
  starts with the gateway base URL, and to nothing else. A request to the
  Keycloak host never carries the platform's token.
- `current-user.ts` decodes the access token's `preferred_username`, `sub` and
  `permission` claims into a signal. Route guards and button visibility read
  `hasPermission`. The guard hides; the backend decides. A 403 that reaches
  the client is rendered as a banner naming the permission the route needed,
  because a hidden button and a refused call are two different facts.
- The demo user in the realm export holds `catalog:write`, `orders:write` and
  `orders:cancel`; the `browser` user holds none. Both are used by the tests.

## 5. Screens

Ionic tabs: **Products**, **Cart**, **Account**, with **Publish** as a fourth
tab that appears only when `catalog:write` is held. Checkout and Order placed
are pushed onto the Cart tab's stack.

### 5.1 Products

Loads the first page with `limit=20`, renders `name`, `amount` and `currency`
per row with the thumbnail when `thumbnailUrl` is present, and appends pages
through `ion-infinite-scroll` with the reply's `nextCursor` until it is null.
Anonymous, so this is the landing tab and works before sign-in. Add-to-cart
changes the local store only.

### 5.2 Cart

Lists lines with quantity steppers and a currency selector. **Get quote** calls
the BFF with one `productId` parameter per distinct product and the selected
currency. Lines the reply names in `unpriced` are marked as such rather than
hidden, because the BFF states the gap instead of failing. The reply's `total`
is shown, never a client-side sum. Requires sign-in; the button prompts for
it. **Checkout** is enabled when a quote exists with no unpriced lines.

### 5.3 Checkout

Address form bound to `AddressDto`'s five fields with the same required set
(`line2` optional), the currency carried from the quote, and one **Place
order** button.

**Command id lifecycle.** A UUID is minted when the page is entered and stored
with the form. Every submission uses that id. A network failure or a 5xx keeps
the id so the retry is a replay. A 409 means the earlier submission won; the
client treats it as success pending confirmation and moves to Order placed
with a note that the id was already committed. A success or any edit to the
form after a failed validation mints a new id. This is the one place the
client holds state across requests on purpose, and `client-architecture.md`
explains why in terms of `IdempotencyBehavior`.

### 5.4 Order placed

Shows the returned order id and a **Cancel** action. The reason is an
`ion-select` over the five codes in §2 with `customer_request` preselected;
the codes are a frozen list in `types.ts` citing `CancelReasons`. Cancel posts
`{ reason }` and reports the 204. The page states, in one sentence, that the
platform exposes no order read yet, so no status is shown. It does not poll,
fake a status or invent one.

### 5.5 Publish

Form for `name`, `thumbnailUrl` (optional), `amount` and `currency`, submitted
as `PublishProductCommand` with the same command-id lifecycle as checkout. On
success the products tab refreshes from the first page.

### 5.6 Account

Sign in and out, `preferred_username`, the permissions held as chips, and the
platform's token posture in one line: on the web, "session ends on reload, no
refresh token"; on native, "refresh token in secure storage, rotated".

## 6. Error handling

`error-mapper.ts` is the only place a failed `HttpErrorResponse` becomes
something a screen shows. It returns a display model
`{ kind, title, detail, fields?, retryAfter? }`.

| Response | Mapping |
|---|---|
| 400 with `errors` object | `kind: validation`; each key becomes a field message. Bodies from `Results.ValidationProblem` and from FluentValidation both carry `errors` keyed by field |
| 400 without `errors` | `kind: banner` with the backend's `title` and `detail` |
| 401 | `kind: signIn`; the caller invokes `AuthService.signIn()` and replays after |
| 403 | `kind: forbidden`; the banner names the permission the route needed, taken from the route's own metadata, not from the response |
| 404 | `kind: banner` with the backend's text |
| 409 | `kind: alreadyCommitted`; see §5.3. Never resubmitted with a new id automatically |
| 422 | `kind: rule`; banner with the backend's `title` and `detail` verbatim |
| 429 | `kind: rateLimited`; `Retry-After` parsed, the action disabled for that long with a countdown |
| 503 | `kind: unavailable`; retry banner |
| other 5xx, network, timeout | `kind: retry`; generic banner plus the correlation id from the response's `X-Correlation-Id` header when present, so a report can be matched to a log line |

No error text is authored on the client beyond the six generic banners for
`signIn`, `forbidden`, `alreadyCommitted`, `rateLimited`, `unavailable` and
`retry`. Where the backend sends `title` and `detail`, they are shown as sent.

## 7. Testing

- **Unit** (Vitest, Angular 22's default runner): `catalog.api`, `ordering.api`
  and `checkout.api` against `HttpTestingController`, asserting the exact path,
  query shape and body for each endpoint; `error-mapper` over one fixture per
  row of §6; `cart.store` and its persistence; the command-id lifecycle in
  §5.3 as a state machine; both auth strategies behind the interface with a
  fake token endpoint, including the `login_required` and rotated-refresh
  paths.
- **Component**: one test per page with the Angular testing harness and Ionic's
  test utilities, driving the page through the mapped errors.
- **End-to-end** (Playwright, `e2e/`): one smoke against the backend's Compose
  stack — sign in as `demo`, browse a page of products, add two, quote, place,
  cancel with `customer_request`; then sign in as `browser` and assert the
  publish tab is absent and a direct navigation to it is refused. Requires
  Docker and the backend checkout. It is never skipped silently: without the
  stack it fails on connection, matching the backend's rule that a skip fails
  open.
- **Import boundaries**: the ESLint rule in §3 runs in `lint`.

## 8. Continuous integration

`.github/workflows/ci.yml`, on push and pull request:

1. Node 22 from `.nvmrc`, `npm ci`.
2. `npm run lint`, `npm test`, `npm run build` (production web build).
3. `npx cap sync android` and `./gradlew assembleDebug` in `android/`, on the
   Ubuntu runner with the Android SDK the runner ships.
4. `npx cap sync ios` on the same runner as a configuration check only. A
   macOS job that runs `xcodebuild` is written and disabled with a comment
   naming the cost, so enabling it is one line.
5. The Playwright smoke runs in a separate job that checks out the backend,
   starts its Compose stack, waits on the gateway's health endpoint, then runs
   `e2e/`. This job is `continue-on-error: false` and is the one that needs
   Docker.

## 9. Backend dependency: the `mobile-app` client

One pull request against `dotnet-ddd-blueprint`, before the native strategy
in §4.2 is implemented:

- `deploy/compose/keycloak/realm-export.json` gains a public client
  `mobile-app`: `standardFlowEnabled`, `pkce.code.challenge.method: S256`,
  `use.refresh.tokens: "true"`, redirect URI `blueprint://auth/callback`, the
  `commerce-api` default scope, no direct access grants, no implicit flow.
  Refresh-token rotation is a realm setting — `revokeRefreshToken: true`,
  `refreshTokenMaxReuse: 0` — and applies to every client, which is
  acceptable because `web-app` receives no refresh token to rotate.
- `deploy/keycloak/realm_check.py` learns a second named client and asserts
  the attributes above on it, with the same test shape `web-app` has.
- §11's flow diagram and the "no refresh token reaches the browser" decision
  gain a paragraph stating that a native client is different because its
  storage is, and citing this document.

The frontend can be built and the web strategy shipped without that PR. The
native strategy is implemented against it and its tests use the client id it
introduces.

## 10. Out of scope

- A mobile BFF, order history, product detail, search, images upload or any
  screen without an endpoint behind it.
- Push notifications, offline mode beyond the persisted cart, deep links other
  than the auth callback.
- Store publication, signing, and iOS builds on this workstation.
- Generated API types (§3, deferred).
- Theming beyond Ionic's defaults and a light and dark palette.

## 11. Versions

Pinned exactly in `package.json`, recorded here so the choice is dated:

| Package | Version |
|---|---|
| `@angular/core`, `@angular/cli` | 22.1.x |
| `@ionic/angular` | 9.0.x |
| `@capacitor/core`, `cli`, `android`, `ios` | 8.5.x |
| `@capacitor/browser`, `app`, `preferences` | 8.x |
| `@aparajita/capacitor-secure-storage` | 8.0.x |
| `angular-oauth2-oidc` | 22.0.x |
| Node | 22.22 or newer, in `.nvmrc` |
