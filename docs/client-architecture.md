# The client's arguments

This document explains why this client is shaped the way it is. Every section
below starts from a decision somebody else made — in the gateway's route file,
in a service's endpoint, in a FluentValidation rule, in the realm export, or in
a library this application depends on — and ends at the file here that answers
it. Nothing in it is a preference. Where this client does something that looks
odd, the oddity is downstream of a fact, and the fact is cited so a reader can
check it at both ends.

**What it was checked against.** The backend at
`alexander-shamray/dotnet-ddd-blueprint`, branch `main`, commit `0d76d27` (the
merge of PR #201). Library behaviour was read out of this repository's own
`node_modules`: `@ionic/angular@9.0.3`, `@angular/core@22.1.6`,
`@angular/build@22.1.8`, `angular-oauth2-oidc@22.0.2`. Where a claim depends on
a version, the version is named.

**The one part that was moving has landed.** Section 12's first deviation —
the quote's total — was a deviation because the endpoint could not price a
basket. Backend PR #201 (ADR-045, "The checkout quote takes quantities")
changed that contract and is on `main`; this client speaks the new one, and
that section now records what the old contract was, what the client did about
it, and what replaced it. Nothing here is known to be in flight.

This client's own spec is
`docs/superpowers/specs/2026-09-10-blueprint-frontend-design.md`; references of
the form "spec §5.2" point there. References of the form "§11.4" are the
backend's own chapter numbers, quoted from the comments that use them.

---

## 1. The catalogue is anonymous, so Products is the landing tab

The gateway's route file (`src/Gateway/Gateway.Api/appsettings.json`) has
exactly one public route, and it says so in a comment before it says it in
configuration: `catalog-public` matches `/api/v1/catalog/{**catch-all}` with
`"Methods": [ "GET" ]`, names `"AuthorizationPolicy": "anonymous"` — YARP's own
reserved value for `AllowAnonymous` — and rate-limits under a policy of the
same name. The comment explains why the key is present at all rather than
omitted: `Common.Web` sets a fallback authorization policy, so a route with no
`AuthorizationPolicy` would inherit it and this public GET would start
answering 401.

The endpoint agrees, and also states itself. In
`Catalog.Api/Endpoints/ProductEndpoints.cs` the route group carries
`.RequireAuthorization()` so anything added later arrives closed, and the
listing GET then carries an explicit `.AllowAnonymous()` with a comment arguing
that an anonymous endpoint has to say so out loud, so that "the reader can tell
a decision from a forgotten line". `CatalogPermissions.cs` closes the loop from
the third side: it holds one constant, `Write`, and records that there is no
`catalog:read` because "a permission nothing requires is a name in a realm
nobody can act on".

So Products is the landing screen and works signed out. `app.routes.ts`
redirects `''` to `tabs/products`; `ProductsPage` issues its first
`CatalogApi.products()` from its constructor and does not reference
`AuthService` anywhere in the file; and `auth.interceptor.ts` attaches a bearer
only when one exists, so the same call is made with or without a session. A
client that demanded a token here would be refusing to show what the platform
publishes.

Two smaller consequences follow from the same route. Pagination is the
backend's cursor shape — `Common.Application/CursorPage.cs`, where a null
`nextCursor` is the last page — so `ProductsPage` sets `hasMore` from
`page.nextCursor !== null` and nothing asks past it. And the anonymous limiter
is a fixed window of 100 requests per minute per remote address
(`Gateway.Api/Program.cs`), which is why a failed page load stops the infinite
scroll asking again on its own: retrying into a 429 is how a rate limit becomes
a loop.

Those are two different facts and the page keeps them in two places, because
conflating them cost the user the rest of the catalogue. `hasMore` is what the
platform said; a failure is what this attempt did. The error branch used to set
`hasMore` false, which reads as "there is nothing more to fetch" — so one 429 or
one 503 on page two ended pagination for the session, and no retry window
closing could bring it back. Now the failure is recorded as an error,
`canLoadMore` is `hasMore && no error`, and a **Try again** control resumes from
the cursor that failed (on a first-page failure that cursor is null, so resuming
and restarting are the same request). The control is itself disabled for the
length of a 429's window, which is the other half of spec §6's 429 row — see
§10.

## 2. Five minutes, and no refresh token in the browser

Two settings in `deploy/compose/keycloak/realm-export.json` decide the whole
session design. The realm sets `"accessTokenLifespan": 300`. The `web-app`
client is public, requires PKCE (`"pkce.code.challenge.method": "S256"`), and
carries `"use.refresh.tokens": "false"`.

That last one is load-bearing, and it is a decision rather than an accident.
Keycloak issues this client no refresh token, so there is nothing for a refresh
grant to redeem. What does survive is the SSO session:
`ssoSessionIdleTimeout` is 1800 seconds and `ssoSessionMaxLifespan` 36000, both
far longer than the token — which is exactly what makes an interaction-free
renewal possible at all.

`core/auth/web-auth.strategy.ts` is the consequence, in three parts.

*Tokens live in memory.* `HybridOAuthStorage` routes precisely three keys —
`PKCE_verifier`, `nonce`, `requested_route` — to `sessionStorage`, and
everything else the library asks to store, every token and every derived claim,
into a `Map` that dies with the page. That list is an allowlist and the
direction is deliberate: a key a future library version adds falls through to
the memory branch, which is safe, whereas under a denylist an unrecognised new
key would default to web storage — a credential leaking because nobody reviewed
a dependency bump. The three that are written out are written because
`initCodeFlow()` performs a real top-level navigation, which destroys the heap
before Keycloak redirects back; without a surviving PKCE verifier the code
exchange omits `code_verifier`, a client with PKCE required is refused, and the
user completes the login screen only to land back signed out.

*Renewal is a silent code flow, not a refresh.* `renew()` calls
`silentRefresh()`, which builds a fresh authorization-code-plus-PKCE URL,
appends `prompt=none` and loads it in a hidden iframe. `refreshToken()` would
perform a grant this realm never issues. The schedule comes from the token's own
`exp` claim, at 75% of its remaining life (`WebAuthStrategy.RENEW_AT`), so
moving `accessTokenLifespan` in the realm moves the client's schedule without a
client release — the number 300 appears nowhere in this repository.

*A reload signs you out, and the account page says so.* `AccountPage.tokenPosture`
renders "Session ends on reload, no refresh token." from
`AuthService.sessionEndsOnReload`. It is one sentence about a realm decision
rather than reassurance, and it is more useful than a silent sign-out the user
is left to explain to themselves.

## 3. Permissions are claims, not roles

The realm's `commerce-api` client scope carries two protocol mappers. One is an
`oidc-audience-mapper` setting `included.client.audience` to `commerce-api`,
which is why `environment.model.ts` documents the scope as mandatory: without
it every service refuses the token. The other is named `permission` — an
`oidc-usermodel-client-role-mapper` with `"multivalued": "true"`,
`"claim.name": "permission"`, `"jsonType.label": "String"` and
`usermodel.clientRoleMapping.clientId` of `commerce-api`. The vocabulary it
projects is five client roles — `catalog:write`, `orders:write`,
`orders:cancel`, `inventory:admin`, `orders:admin` — and the realm's two users
differ precisely there: `demo` holds the first three, `browser` holds none.

The fifth is the one that makes this section's title literal, so it is worth
naming rather than leaving to a reader who checks. `orders:admin` is described
in the realm as "Act on an order the caller does not own (§11.4). A claim
`CancelOrderHandler` reads, never an endpoint policy. Grantable and granted to
nobody" — and `Ordering.Api/OrderingPermissions.cs`, which holds `orders:write`
and `orders:cancel` as constants, deliberately does not hold this one and
spends a paragraph on why: it is "a *claim* that `CancelOrderHandler` checks
against a loaded aggregate, not a *policy* an endpoint names — a question no
endpoint could answer, because the order is not loaded when the policy runs."
So the same realm role reaches the two hosts as two different kinds of thing:
one an endpoint can require before it does any work, one only a handler can
answer with the order in front of it. Nothing in this client reads it — no
screen acts on an order the user does not own — but it is the sharpest
illustration of what the `permission` claim is, which is why the count above
has to be right.

Roles go in; a claim comes out; the services read the claim. That is what
`core/auth/current-user.ts` mirrors: `decodeUser()` reads `permission` and the
three other claims this client actually uses, and nothing else. It does not
verify the signature, deliberately — every host validates its own tokens, and a
client that checked one would be asserting something it cannot enforce. What is
read here decides what is *shown*, never what is *allowed*.

`toPermissions()` exists because of one detail of that mapper: Keycloak's
multivalued mapper emits an array for two or more values and a bare string for
one. Spreading the scalar case would turn `"orders:write"` into eleven
single-character permissions, none of which match anything — a button that
silently stays hidden for exactly the user who has one grant.

The claim then shows up three times, and the repetition is the point:

- `tabs.page.ts` hides the fourth tab unless `hasPermission('catalog:write')`.
- `app.routes.ts` puts `permissionGuard(PERMISSIONS.catalogWrite)` on
  `tabs/publish`, so a typed URL is refused even though the tab is absent.
- `mapError`'s 403 branch produces a banner that names the permission.

A hidden button and a refused call are two different facts, and only the third
layer — the backend — decides anything. Note where that banner gets its text:
the permission comes from the route's own metadata
(`mapError(failure, { permission: PERMISSIONS.catalogWrite })`), never from the
response, because the response deliberately names none. Echoing one would be the
backend describing its own policy to a caller it has just refused.

The guard's redirect carries the name forward as a query parameter
(`/tabs/account?denied=catalog:write`), which is why the account page reads that
parameter reactively — see section 12.

## 4. Idempotency is keyed on the command id, so the id belongs to the form

`Common.Application/IdempotencyBehavior.cs` builds its key as
`$"{Subject()}:{TCommand.OperationName}:{command.CommandId}"`, where `Subject()`
is the authenticated principal's id (or the literal `"system"` when there is
none), and `OperationName` is a `static abstract` member each command declares
explicitly — `"catalog.product.publish"`, `"ordering.order.place"` — so that
renaming a CLR type cannot change a live key. The claim survives 24 hours
(`IdempotencyRetention.Window`), and a durable marker written inside the
transaction outlives it.

Three facts fall out of that key, and this client is built on all three:

1. **A retry under the same id is a replay**, not a second order.
2. **A concurrent second request under the same id is refused**, with 409
   `request.in_progress`.
3. **A retry after the result has expired** is refused with 409
   `command.already_committed` — the work happened, and the platform can no
   longer tell you what it produced.

Validation sits *outside* that behaviour, which is the fourth fact and the one
that shapes the state machine. `PublishProductValidator.cs` requires `CommandId`
to be non-empty and argues it in place: an omitted id binds as `Guid.Empty`, "a
single shared key rather than an absent one", and validation is the outer
behaviour, so its 400 is raised before any key is claimed.

`core/commands/command-id.ts` is that lifecycle written once, as a state
machine, rather than three lines scattered through two pages. `CommandIdentity`
mints an id per *form*. `onFailure()` records whether the failure was a
validation refusal (which claimed no key) or anything else (which may have
committed); `onEdit()` releases the id only in the first case; `onSuccess()`
mints a new one. A `command.already_committed` marks the identity permanently
spent, and no edit may release it — resubmitting changed data under a fresh id
is exactly the duplicate the mechanism exists to prevent.

One deliberate non-guard is worth naming. `CheckoutPage.placeOrder()` does not
block a double-click while a request is in flight. Two requests under one id is
the platform answering `request.in_progress` to the second, which is the
mechanism working as designed; suppressing it client-side would hide the thing
this client exists to demonstrate. `OrderPlacedPage.cancel()` makes the opposite
choice for a reason specific to it: `CancelOrderRequest` carries no command id
at all — the wire body is `{ reason }` alone — so a second tap replays nothing,
it is a second uncorrelated write that can surface EF's
`request.concurrency_conflict`.

## 5. Three 409s, not one

`Common.Web` registers three exception handlers that all answer 409, and they
give contradictory instructions:

| `code` | Handler | What its `detail` tells a person |
|---|---|---|
| `request.in_progress` | `ConcurrentRequestExceptionHandler` | "A request with this command identifier is already in progress. Retry." |
| `command.already_committed` | `CommandAlreadyCommittedExceptionHandler` | "This command has already been applied and its result is no longer available; read the resource rather than retrying." |
| `request.concurrency_conflict` | `ConcurrencyExceptionHandler` | "The resource was modified by another request. Re-read it and retry." |

Two say retry. One says do not. The handlers themselves argue that the
distinction must not be carried by the prose: RFC 9457 makes `detail`
human-readable, so a caller "switching on English prose breaks on a reword", and
each handler puts its discriminator in a `code` extension member instead. The
same member carries `Error.Code` on the failures `ResultExtensions` maps, so one
field answers the question on every problem response the platform produces.

`core/errors/error-mapper.ts` switches on `code` and never on `detail`. Its
`CONFLICT_KINDS` map is those three codes verbatim, and the fallback for a 409
with no readable code is `alreadyCommitted` — the kind that forbids the retry.
That asymmetry is deliberate: guessing "retry" on a command that already
committed is the one wrong answer that places a second order, where guessing
"already committed" on a retryable conflict merely makes the user click again.

`error-banner.component.ts` then holds one sentence per kind, used only where
the backend sent no `title` of its own. Wherever the backend sent text, the text
is shown as sent.

## 6. 200, not 201

`Common.Web/ResultExtensions.cs` is, in its own words, "the one place §10.5's
status-code table is executed rather than remembered". `Result<TValue>` becomes
`Results.Ok(result.Value)`; a bare `Result` becomes `Results.NoContent()`; and
failures map `NotFound → 404`, `Rule → 422`, `Unavailable → 503`. There is no
`Created`, no `Location` header, and no overload that could produce one.

Both of this client's writes therefore answer **200 with a bare id in the body**
— `POST /api/v1/catalog/products` and `POST /api/v1/orders` — and the
cancellation answers 204. The spec this client was built from says 201 for both
writes (spec §2's table). The spec was wrong and the platform is right, so
`CatalogApi.publish()` and `OrderingApi.place()` are both typed
`Observable<string>` and read the id out of the body.

The absent `Location` is not an oversight either, and it leads directly into the
next section: a `Location` header has to point at something, and there is
nothing to point at. Neither service exposes a per-resource GET.

## 7. There is no order read, and the client says so instead of inventing one

`Ordering.Api/OrderingPermissions.cs` holds two constants and explains the
absence of a third: `orders:read` is "deliberately absent until there is a read
endpoint to require it — a service's vocabulary holds what its endpoints require
and nothing else, and a permission nothing requires is a dead name in the
realm". `OrderEndpoints.cs` bears that out: `POST /v1/orders` and
`POST /v1/orders/{id}/cancel`, and nothing else.

`core/api/ordering.api.ts` has `place()` and `cancel()` and no read, with the
omission recorded as the platform's rather than the file's. The consequence
lands on the screen: `OrderPlacedPage` renders the id it was navigated with,
states in one sentence that "the platform exposes no endpoint that reads an
order back, so no status is shown here", and does not poll. There is no spinner
waiting for a status that will never arrive, and no invented "Processing…".

The same absence explains the sentinel. When checkout's submission is answered
`command.already_committed`, the order exists, the platform no longer holds the
result, and there is no id — so `CheckoutPage` navigates to
`/tabs/cart/placed/already-committed` (`ALREADY_COMMITTED`, which lives in
`core/commands/command-id.ts` because two features need it and a feature never
imports another feature), and the placed page renders the honest paragraph: the
order exists, its id is not recoverable from here. With a read endpoint, that
page would look it up. Without one, saying so is the only truthful option.

## 8. The BFF names the gap rather than dropping the line

`Web.Bff/Endpoints/QuoteResponse.cs` carries an `Unpriced` list, and documents
why: those are "the products asked about that Catalog returned no price for —
unknown, unpublished, or priced in another currency. Named rather than omitted:
a form that silently drops a line the customer chose is worse than one that says
it cannot price it."

A client is free to ignore that member, and would then show a quote silently
covering fewer lines than the cart holds. This one reads it twice.
`CartPage.isUnpriced()` marks the individual line — "Not priced in EUR" — and
`canCheckout()` requires `q.unpriced.length === 0`, so checkout is blocked
rather than proceeding with an order for a product the platform could not price.
The BFF went to the trouble of stating the gap; the screen is where stating it
has to mean something.

## 9. The total is the BFF's, and the client never computes money

`QuoteResponse.cs` says why the total is computed server-side at all: "the total
is computed here because every client would otherwise compute it, and two
clients computing a total is two places to get rounding wrong." That is the
rule, and this client follows it without exception: no page multiplies, divides,
sums or rounds an amount. Prices are rendered as the numbers they arrived as.

It is worth seeing how much care the BFF puts into the arithmetic it is
protecting, because that is the argument for not duplicating it.
`CheckoutEndpoints.cs` parses Catalog's decimal strings with
`CultureInfo.InvariantCulture` and a deliberately narrow `NumberStyles` set —
`AllowThousands` is excluded, because under the invariant culture `"12,50"`
would otherwise parse as twelve hundred and fifty, "the exact hundredfold error
the invariant culture was supposed to rule out, arriving through the styles
argument instead". It then refuses a negative amount, refuses a reply whose
currency disagrees with the request, and refuses a product it did not ask about
or has already been answered — each a 500 naming the product, because each is a
contract violation between two services rather than a caller's mistake, and each
would otherwise surface only as a wrong total.

The client's side of that bargain is smaller and has the same shape. The
currency an order is placed in is carried from the quote rather than picked
again: `CheckoutPage.currency` is `computed(() => this.handoff.quote()!.currency)`
with no fallback, because a `?? 'EUR'` would be a guess about money — and it
would be read on exactly the path where the guess is certainly wrong, since no
quote means nothing priced this basket in any currency. The non-null assertion
is safe because `quoteGuard` refuses the route without a quote, which is the
reason that guard exists.

The rule now buys the screen a basket total rather than costing it one.
`QuoteResponse.Total` is the sum of the line totals, `QuoteLine.LineTotal` is
`Amount * Quantity`, and both arrive computed — so the cart renders
"2 × 12.50 = 25.00" with all three of those numbers read off the reply, and its
total as `Total: <total> <currency>`. The client multiplies nothing, which is
the same rule it followed when the arithmetic was not on offer. Section 12
records what it did then, and why.

## 10. `Retry-After`, the correlation id, and what CORS lets a browser see

`Gateway.Api/Program.cs` rejects over-limit requests through
`IProblemDetailsService` rather than writing JSON directly, "so a 429 is the
same shape as every other error the platform returns" —
`application/problem+json` carrying the `correlationId` and `traceId` members.
Its `OnRejected` handler sets `Retry-After` from the limiter lease's metadata
when the lease carries it.

Two headers then have to cross an origin boundary, and neither is
CORS-safelisted. The gateway's policy names both explicitly —
`.WithExposedHeaders("Retry-After", CorrelationIdExtensions.Header)` — and the
comment beside it makes the division of labour precise: the problem body carries
the same id as a `correlationId` member, but a body exists only where a problem
does, so "the header is what a 200 or a 204 still carries, so the body is the
fallback for whatever cannot read the header … and the header is the fallback
for every response the body does not exist on."

This client reads the body. `core/errors/problem-details.ts` documents
`correlationId` as `ProblemDetailsExtensions`' own extension member, and
`mapError()` takes it from `body.correlationId` — never from `X-Correlation-Id`.
Every response this client shows an id for is a problem response by definition,
so the body is always there, and reading it depends on nothing but the response
being JSON. (The id itself is minted by the gateway's correlation middleware for
any request that arrives without one, so the client sends no such header either.)

`Retry-After` has no body equivalent, so it is read from the header, and read
defensively. `mapError`'s 429 branch handles a missing header, an empty or
whitespace-only one, and a non-numeric one — HTTP permits an HTTP-date form that
this gateway never sends, so a date is out of contract and must fall back rather
than be trusted as `NaN` seconds or, worse, `Number('')` coercing to a
false-fact zero. When the value cannot be read, the client substitutes
`RATE_LIMIT_FALLBACK_SECONDS` — 60, chosen because the authenticated policy is a
token bucket of 300 tokens replenished 300 per minute, so a minute is the honest
round number rather than a tuned guess — and sets `retryAfterIsFallback`, which
the banner renders as "the platform sent no readable Retry-After, so that is
this app's own estimate". A countdown presented as fact when it is a guess is a
lie the user cannot detect. Note what that sentence does *not* do: it does not
say why the value was unreadable. The response does not carry that, so naming a
cause would be the banner asserting a diagnosis it cannot make — which an
earlier wording did, blaming a CORS exposure that the next paragraph shows is in
place.

**What the backend's Task 0 changed.** That exposure is recent: it arrived with
`27b54a7` ("feat(gateway): route catalog writes, expose Retry-After, add
mobile-app client"), merged to `main` in PR #200, alongside the correlation-id
exposure. Against a gateway at or after that commit, with `Cors__Enabled` set as
`deploy/compose/services/gateway.yml` sets it, the countdown a user sees is the
gateway's own number and the fallback is dead code on the happy path.

It stays, and the reasons are worth stating precisely, because one plausible
reason is not among them. A 429 from *this* gateway always carries the header:
`OnRejected` reads `MetadataName.RetryAfter` off the lease, and both policies —
a fixed window and a token bucket — leave `QueueProcessingOrder` at its default
`OldestFirst`, under which every rejection those two can produce carries that
metadata. The metadata-less lease the BCL can hand back needs `NewestFirst`,
which neither policy sets. So "the limiter rejected without saying for how
long" is not a case this client will meet, and the code comment on the constant
says so rather than claiming it.

What remains is everything between that gateway and `mapError`: a header that
arrives empty, whitespace-only, non-numeric or in HTTP's date form; an
intermediary that strips it; a deployment with `Cors__Enabled` off, where the
header is sent and the browser is not permitted to read it; and a gateway older
than `27b54a7`, which is every gateway before the exposure landed. The header
forms are what `error-mapper.spec.ts` pins, one test each, alongside the header
being absent altogether — five cases, which is every shape `mapError` can be
handed. The client's answer to all of them is the same, and that is the point:
*unreadable* is a fact about the response, and saying what you do not know does
not require knowing why you do not know it.

## 11. The gateway is the only host the client calls — and Publish needed a route for that to stay true

`catalog-public` matches `GET` alone, and the route file argues the restriction
rather than assuming it: a separate `catalog-write` route exists "because the
two differ in every field that matters — policy, limiter, and the reason each
exists", and keeping them apart is what stops "a public listing [becoming] a
public publish by widening one line".

That has a blunt consequence for this client. Until `catalog-write` existed,
`POST /api/v1/catalog/products` had no matching route at the edge at all: the
publish screen's request 404'd at the gateway without ever reaching Catalog.
The client's comments record that state (`catalog.api.ts`, `publish.page.ts`),
because it was true while the screen was being written. It is no longer: the
route landed on backend `main` in the same commit as the `Retry-After`
exposure, and the Playwright smoke now proves it end to end — the publish
succeeds and the product appears on the Products tab.

The alternative, during that window, was to call `catalog-api` directly.
Compose does publish it — `127.0.0.1:5102:8080` in
`deploy/compose/services/catalog.yml`, as it publishes `ordering-api` on 5101
and `web-bff` on 5200 — so the call would have worked on a developer's machine.
It was refused for three reasons, in increasing order of seriousness. Those
ports are a local debugging affordance and do not exist in a deployment where
the gateway is the ingress. Only the gateway is configured for CORS
(`Cors__Enabled` appears in `gateway.yml` and nowhere else under
`deploy/compose/`), so under this Compose configuration a browser could not
read the response. (Scoped deliberately: the grep behind that parenthesis covers
what Compose *configures*, and a service enabling CORS from its own `Program.cs`
would not appear in it.) And the edge is where the authorization policy, the
rate limiter and the correlation id are applied — a client that goes around it
is not exercising the platform, it is exercising one service with the platform
switched off.

So `environment.model.ts` holds exactly one `gatewayBaseUrl`, and
`auth.interceptor.ts` attaches the bearer to that origin and to nothing else.
The comparison is a boundary check rather than a bare `startsWith`, because
`http://localhost:5000` is a prefix of `http://localhost:50001` and a token sent
to the wrong host is a token leaked to it.

One configuration fact belongs here too, because it looks arbitrary and is not.
This application's dev server runs on port **5173**, not Angular's default 4200
(`angular.json`, `serve.options.port`). The realm's `web-app` client lists
`http://localhost:5173/*` in `redirectUris` and `http://localhost:5173` in
`webOrigins`, and `gateway.yml` sets
`Cors__Origins__0: "http://localhost:5173"`. A client that needed any of those
changed would be a client the backend has to accommodate, which is backwards.

## 12. Deviations from the spec, and what execution discovered

Each of these is written as the claim that turned out to be wrong, what is
actually true, and where in this client the truth shows.

### The quote's total was not the basket's total, and now it is

*The claim.* `QuoteResponse.Total` is the price of the cart, so the cart renders
it as one.

*What was true, and why the claim failed.* `GET /bff/v1/checkout/quote` took
repeated `productId` query parameters and one `currency`, and nothing else. The
request carried no quantities. `CheckoutEndpoints.cs` deduplicated the ids
(`productId.Distinct()`), asked Catalog for one price each, and returned
`lines.Sum(line => line.Amount)` as `Total`, where `QuoteLine.Amount` is the
price of one unit. For two of product A and one of B, the total was `A + B`.
Correct against its own contract, and not the basket.

*What the client did about it.* `CartPage` had two ways to present that number
and both were refused. Multiplying the line prices by the cart's quantities
would have been the client computing money, which is precisely what section 9
forbids and what the BFF computes server-side to prevent. Labelling the figure
"Total" would have been a false statement about the customer's basket. So the
cart labelled it for what it was — **"Quoted unit prices"**, with a note that
the platform prices products rather than baskets — and showed each line's
quoted unit price beside its quantity. The e2e smoke asserted that exact string
rather than the word "Total", which is how the mismatch was caught in the first
place.

*What is true now.* Backend PR #201 merged ADR-045, "The checkout quote takes
quantities". The endpoint is `POST /bff/v1/checkout/quote` with a body of
`{ currency, lines: [{ productId, quantity }] }` — a body rather than a
`quantity` array beside the `productId` one, because ASP.NET binds two repeated
parameters independently and nothing then enforces that the *n*th quantity
belongs to the *n*th id. `QuoteLine` gained `Quantity`, echoed from the request
so the reply stands alone, and `LineTotal`, which is `Amount * Quantity`
computed by the BFF; `Amount` keeps its name and its meaning as the unit price,
because a cart renders "£12.50 each" beside the line total. `Total` is the sum
of the line totals — the basket. A product named by more than one line is
**merged** rather than refused or dropped, because `Order.AddLine` merges the
same basket one service over, and the reply echoes the summed `Quantity` so the
merge is visible. The bounds moved to
`Common.Contracts.Ordering.V1.OrderLimits` — `MinQuantity` 1, `MaxQuantity` 999
checked against the *merged* quantity, `MaxLines` 100 — so that
`PlaceOrderValidator` and the BFF's `QuoteRequestValidator` read the same
numbers and a quote can never price a basket the order would refuse. `v1`
changed in place; there is no `/v2`.

*Where it shows now.* `CheckoutApi.quote()` takes the cart's lines and POSTs a
`QuoteRequest`; `CartPage.getQuote()` hands it `{ productId, quantity }` per
line — narrowed from `CartLine`, which also carries the listing price that the
pricing endpoint has no business being told, the same narrowing `CheckoutPage`
does when it builds `PlaceOrderItem`. Nothing deduplicates on the way out: the
`new Set(productIds)` the old client used was right when a repeated id carried
no information and would discard a quantity now. `CartPage.quotedLines` keys
the reply's lines by product id and the template renders
`{{ quantity }} × {{ amount }} = {{ lineTotal }}`, every figure read off the
reply; the total is labelled **`Total:`**, which is what the e2e smoke now
looks for. The bounds are not mirrored in `types.ts` and nothing here enforces
them: past them the platform answers a field-keyed 400 that `mapError()`
already surfaces, and a second copy of a limit is a copy that drifts from the
one actually enforced — the same argument `CheckoutEndpoints.cs` makes for not
re-checking Catalog's id ceiling.

The client's own rule did not change; what the platform could offer did. That
is the ADR's reading of it too — "the rule was right and the endpoint could not
honour it" — and this client's relabelling is the evidence it cites.

### A product may cost nothing

*The claim.* A price is a positive number, so a falsy price means "no price".

*What is true.* `PublishProductValidator.cs` requires `NotNull()` and
`GreaterThanOrEqualTo(0)`. Zero is a legal, publishable price. (The upper bound
is storage's — `PriceAmount` is `decimal(19,4)` — and the validator refuses at
`999_999_999_999_999.995m` so that `Money.Of`'s half-to-even rounding cannot
push a legal value into an overflow at `SaveChanges`.)

*Where it shows.* `CartPage.quotedLines` is a `Record<string, QuoteLine>` — a
record of *lines* rather than of amounts, and that is what makes the template's
`@if (quotedLines()[line.productId]; as quoted)` safe: a line object is never
falsy, so a missing lookup is the only thing the guard can mean. While the same
record held numbers it had to be tested with `!== undefined`, because
`@if (price; as p)` would hide a free product as though it had never been
quoted. A test pins it — a line quoted at zero renders. The same reasoning
appears one level down in the publish form — see `Validators.required`, below.

### A customer may not name the platform's reasons

*The claim.* `CancelReasons` is the wire vocabulary, so a cancel screen offers
the customer all five codes.

*What is true.* Four of the five are facts the platform discovers rather than
choices a person makes: `out_of_stock` and `stock_timeout` come from the
fulfilment saga, `payment_declined` and `payment_timeout` from Payments. And
`OrderEndpoints.cs` stamps every cancellation arriving through the HTTP route
with `CommandOrigin.User`, whatever code was sent — the origin is "not the
caller's to state".

*Where it shows.* `core/api/types.ts` mirrors all five codes, because that is
the wire vocabulary and the backend refuses a sixth with a 400 keyed `Reason`
("Not a known cancellation reason."). `OrderPlacedPage` offers none of them: it
sends `customer_request` and says so on screen ("Cancelling here is recorded as
the customer's own request"). The alternative would let a customer record
"cancelled because payment was declined, origin user" — a statement about an
incident that did not happen — and the backend's own comment notes that
`payment_declined` and `payment_timeout` are one dimension value apart on the
`orders.cancelled` metric and "a different incident", so a mis-picked code lands
in the data operators read during one.

### Navigating to a tab does not reload it

*The claim.* Going back to the Products tab after publishing re-runs the page
and shows the new product.

*What is true.* `IonRouterOutlet` delegates to Ionic's `StackController`, which
keeps a per-stack list of views and, for a URL it has already activated, returns
the cached `ComponentRef` (`StackController.getExistingView`, which also calls
`changeDetectorRef.reattach()`) rather than constructing a new one. A tab root's
constructor runs once per app session, not once per visit.

*Where it shows.* `core/catalog/catalog-refresh.ts` exists for exactly this. The
publish page cannot call `ProductsPage.reload()` — a feature never imports
another feature, enforced by an ESLint rule and by `core/boundaries.spec.ts` —
so it calls `CatalogRefresh.request()`, which bumps a version signal that
`ProductsPage` watches in an `effect()`. A publish must *ask* the catalogue to
reload; nothing about arriving there does it. The smoke proves the mechanism
rather than the outcome: the new product appears after a tab click, with no
`page.reload()` anywhere in the test.

Both watchers of that idiom — `ProductsPage`'s `constructedAtVersion` and
`OrderPlacedPage`'s `constructedForId` — capture the value they were built with
and compare against it, because an `effect()` runs once immediately over every
signal it reads and that first run is the construction's own work.

### `provideIonicAngular()` does not install `IonicRouteStrategy`

*The claim.* Ionic's provider function sets up Ionic's routing behaviour.

*What is true.* `provideIonicAngular()`
(`@ionic/angular/dist/standalone/providers/ionic-angular.js`) provides the
config token, an initializer that boots the custom-elements build,
`provideComponentInputBinding()`, `AngularDelegate`, `ModalController` and
`PopoverController`. It does not provide a `RouteReuseStrategy`. Angular's
default strategy compares only `routeConfig` identity, so navigating
`placed/A → placed/B` hands the second order the same component instance and the
same `ActivatedRoute`, and a page that read `route.snapshot` once would show the
first order's id for ever after.

*Where it shows.* `app.config.ts` provides
`{ provide: RouteReuseStrategy, useClass: IonicRouteStrategy }` explicitly. That
is the app-wide fix; `OrderPlacedPage` additionally reads its id through
`toSignal(this.route.paramMap…)` rather than leaning on a fact maintained three
files away.

*And the limit, because it bit this client too.*
`IonicRouteStrategy.shouldReuseRoute`
(`@ionic/angular/dist/common/utils/routing.js`) compares `future.routeConfig`
against `curr.routeConfig`, then `future.params` against `curr.params`. Those
are **route** params. Query params are not compared at all, so
`/tabs/account` → `/tabs/account?denied=catalog:write` reuses the component by
design. That URL is precisely what `permissionGuard` redirects a refused
navigation to, and Account is a tab root whose constructor has usually already
run — so `AccountPage.denied` subscribes to `queryParamMap` instead of reading a
snapshot. Reading the snapshot would mean a user who had opened Account even
once was afterwards redirected there by the guard and shown nothing at all.

### State at a tab root never gets a teardown

*The claim.* Leaving a page and coming back rebuilds it, so per-page state gets
a fresh start eventually.

*What is true.* Ionic's `setBack` (`stack-utils.js`) keeps
`v.stackId !== view.stackId || v.id <= view.id` — it prunes only the views
*above* the one being returned to, within the same stack, and touches other
stacks not at all. `StackController.setActive` then destroys exactly the views
the new list dropped. A tab root has the lowest id in its stack, so nothing
above it ever includes it: it is reattached, never destroyed, for the life of
the app session.

*Where it shows.* Two pages hold a `CommandIdentity`, and they escape a spent
one differently because their positions differ. `CheckoutPage` sits deeper in
the Cart tab's stack and navigates away on both terminal outcomes, so it is
genuinely rebuilt — a later visit constructs a fresh identity and it needs no
in-place recovery. `PublishPage` is a tab root and never navigates anywhere, so
a spent identity there would be permanent and the Publish tab dead for the rest
of the session. It therefore recovers in place: `command.already_committed` is
treated as the completed submission it is — the platform is saying the product
exists and it no longer holds the result — so the handler clears the error,
records the published id as the `already-committed` sentinel, calls
`identity.onSuccess()` to mint a fresh id, resets the form, and asks the
catalogue to refresh. One backend code, two client answers, because one page can
be rebuilt and the other cannot.

`AccountPage` carries a smaller instance of the same fact, documented in place
and deliberately left: a failed sign-in banner survives a tab switch, because
nothing tears the page down. It stays because that loop is *open* — the Sign in
button that clears it is always enabled — where the publish page's spent
identity was a closed loop with a disabled affordance.

### A rejection is not an `HttpErrorResponse`

*The claim.* Everything a client catches is an HTTP error, so the error mapper
can take one.

*What is true.* `angular-oauth2-oidc@22.0.2` rejects `loadDiscoveryDocument()`
with a bare string in at least two places — `reject("issuer must use HTTPS…")`
and `reject('discovery_document_validation_error')`. There is no response to
read a status or a body from.

*Where it shows.* `mapError()` takes `unknown`, narrows internally, and returns
a `retry` kind for anything it does not recognise. That branch was added for
`CartPage`'s sign-in retry, the first call site that is not an `HttpClient`
error handler; `AccountPage`'s `signIn()`/`signOut()` catch blocks annotate the
failure `unknown` for the same reason — annotating it `HttpErrorResponse` would
be a claim the runtime does not honour.

### The auth initializer must never reject

*The claim.* If identity cannot start, the application cannot start.

*What is true.* `provideAppInitializer` hands its promise to bootstrap and a
rejection aborts bootstrap entirely; `main.ts`'s
`bootstrapApplication(...).catch((err) => console.error(err))` logs the failure
and does not recover from it. The whole application renders a blank page —
including the anonymous product catalogue, which has nothing to do with
identity.

*Where it shows.* `WebAuthStrategy.initialize()` catches, resolves, and leaves
the app in its signed-out state, and `AuthService.initialize()`'s contract says
so on the interface, so a future native strategy inherits the requirement. It
then distinguishes the two failures it caught, using
`OAuthService#discoveryDocumentLoaded` — the library sets it true only on
`loadDiscoveryDocument()`'s success path and never clears it. If discovery
succeeded and `tryLogin()` failed, a stray `access_token` may already sit in
storage that this strategy never adopted, so `logOut(true)` clears it and makes
the two states agree. If discovery itself failed, `signIn()` must retry it:
`initCodeFlow()` with an empty `loginUrl` does not navigate — it subscribes to a
`discovery_document_loaded` event and returns, and since discovery already
failed, nothing will ever fire it. Without the retry, Sign in would be a button
that silently does nothing for ever, which is a worse bug than the blank page
that prompted the fix.

### A response can outlive the state it was computed for

*The claim.* A response answers the request that produced it, so applying it is
always safe.

*What is true.* It answers the state that existed when it was sent. Two places
here can invalidate that state mid-flight: `ProductsPage.reload()` (triggered by
a publish) starts a new pagination sequence while a `loadMore()` is outstanding,
and `CartPage.invalidateQuote()` (a currency change) supersedes a quote still in
flight.

A quote has a second, sharper version of the same problem, and it is answered in
the store rather than on the page. A quote is a statement about one basket, and
the basket can change from a screen that has never heard of quotes:
`ProductsPage.addToCart()` calls `CartStore.add()` directly. Invalidation that
hung off the cart page's own steppers and currency select therefore missed it,
and `quoteGuard` went on admitting `/tabs/cart/checkout` with a total priced for
a basket the customer no longer had. So `CartStore` carries a `version` bumped by
every mutation that changes the lines — the same shape as `CatalogRefresh` — and
both holders of a quote (`CheckoutHandoff`, which the guard reads, and
`CartPage`, which decides whether Checkout is enabled) record the version they
were quoted at and report nothing once it moves. They compare against one
counter, so they cannot disagree. The version is captured when the request is
ISSUED, not when the reply lands, or a reply overtaken by an `add()` from
another tab would stamp itself fresh.

*Where it shows.* Both carry a generation counter, captured when the request is
issued and re-checked when it lands; a response from a superseded generation is
dropped. The products page still calls the infinite scroll's `complete()` on the
dropped branch, because Ionic's `InfiniteScroll` will not fire again while its
internal `isLoading` flag stands — skipping it would reintroduce the hang the
guard exists to avoid. A `switchMap` was rejected because it hides the drop
rather than stating it, and because `load()` has three call sites with different
completion semantics.

`CartStore` closes a related race by object identity rather than a flag: its
persistence `effect()` refuses to write the exact array the store was
constructed with, so a flush landing while `restore()` is still awaiting storage
cannot persist `[]` over a real cart. A `hydrated` boolean was refused twice
over — set and cleared inside `restore()` it is a structural no-op under
zoneless change detection, and wired correctly it would make any `CartStore`
whose caller forgot to call `restore()` stop persisting silently.

### `Validators.required` accepts `0`

*The claim.* A required validator rejects a falsy value, so a required number
field cannot submit zero.

*What is true.* `@angular/forms`' `isEmptyInputValue` is
`value == null || lengthOrSize(value) === 0`, and `lengthOrSize` returns a
length only for strings, arrays and `Set`s — for the number `0` it returns
`null`, so `0` is *present*, not empty.

*Where it shows.* `PublishPage`'s amount control is
`new FormControl<number | null>(null, { validators: Validators.required })`.
That is what lets the form send the free product
`PublishProductValidator.cs`'s `GreaterThanOrEqualTo(0)` permits, while still
refusing a blank field — which binds `null` and is genuinely empty. The nullable
control type mirrors the backend's own `decimal?`, for the reason that field
states: a bare `decimal` cannot say "absent", and an omitted amount would bind
as 0 and publish a free product indistinguishable from a deliberate one.

### Tooling: `ng new`, not `ionic start`; Vitest 4, not 5

*The claim.* The spec says the application is "generated by the Ionic CLI"
(spec §3).

*What is true.* `@ionic/cli`'s latest published version is 7.2.1, last modified
2025-03-18, and its starter templates predate Angular 22.
`@ionic/angular@9.0.3` ships an `ng add` collection and peers
`@angular/core >=18`.

*Where it shows.* The workspace was generated with `ng new` and then
`ng add @ionic/angular@9.0.3`, which produces the same standalone application
against a current Angular. Two further scaffold facts came out of that. Angular
22's default schematic no longer wires ESLint at all, so it was added separately
(`ng add @angular-eslint/schematics@22.5.0`); and it installs no `zone.js` —
`@ionic/angular` lists it as an *optional* peer — so
`provideZonelessChangeDetection()` is stated explicitly in `app.config.ts`
rather than left implicit. Several comments in this repository turn on zoneless
scheduling being real, and that is not a fact worth inferring from a default.

The test runner is Vitest **4.1.11**, not 5: `@angular/build@22.1.8` declares
`"vitest": "^4.0.8"` in its peer dependencies, and `@angular/build:unit-test` is
what `ng test` runs. Its `coverage` option is a plain boolean rather than an
object — worth recording, because the obvious object form fails.

## 13. The bundle budget is set above the bundle, not at it

`npm run build` was failing before this work could ship, and the failure was the
budget rather than the bundle. `ng new` writes a 1 MB error budget for the
initial bundle, tuned for a bare Angular application; this one is an Ionic
application with an OIDC library, and it measures **1.05 MB raw / 208.15 kB
transferred**, of which `main` is 940.86 kB raw and 179.88 kB transferred.

Transferred is what a user pays, and 180 kB gzipped for Angular 22, Ionic 9 and
`angular-oauth2-oidc` is what this application honestly weighs. Every feature
page is already lazy (`app.routes.ts` uses `loadComponent` throughout, and the
build reports each page as its own chunk of 2–5 kB). The two eager costs are
required at bootstrap and cannot be deferred: Ionic's core runtime, initialized
by `provideIonicAngular()`, and the OIDC library, which `provideAuth()` pulls in
because its app initializer runs there.

So the budget moved to **warn at 1.2 MB, error at 1.5 MB** (`3450e13`). The
numbers are chosen to still catch the regression worth catching — a lazy route
made eager, or a heavy library pulled into the shell — which costs hundreds of
kilobytes rather than tens. A budget set to exactly current usage fails on the
next honest line of code; one set to the sky never fails at all. Neither tells
you anything on the day it trips.

## 14. What CI runs, and the one test that is left failing

`.github/workflows/ci.yml` has four jobs. The `web` job installs from the
lockfile and runs `npm run lint`, `npm test` and `npm run build`. The Angular
unit-test builder runs once and exits rather than watching, which is checked
locally with `CI=true npm test` — a watch-mode test step does not fail a build,
it consumes the job's entire timeout, which is a far more expensive way to find
out.

The `e2e` job checks out this repository and the backend, starts the backend's
Compose stack with `--wait`, polls the gateway's `/health/ready` for five
minutes, and runs the Playwright smoke against it. It is deliberately not
`continue-on-error`: a smoke that is allowed to fail is a smoke nobody reads. On
any outcome it captures `docker compose logs`; on failure it uploads those logs
together with `test-results/`.

The `android` job compiles the committed Android project — `npm ci`, `npm run
build`, `npx cap sync android`, `./gradlew assembleDebug`. The sync step is not
optional: `android/app/src/main/assets/public` is gitignored, so a fresh
checkout has no web assets in the native project at all until it runs. The job
needs no Android SDK setup step because the `ubuntu-24.04` runner image ships
`android-36` — which is what `android/variables.gradle` compiles against — and
sets `ANDROID_HOME` itself. That job therefore pins `runs-on: ubuntu-24.04`
rather than following the other three onto `ubuntu-latest`: the claim above is
about an image, and `ubuntu-latest` is a label that moves.

The `ios-config` job is a configuration check and says so: `npx cap sync ios`
copies web assets and writes `Package.swift` and `capacitor.config.json`, and
it does not compile Swift. It catches a plugin missing from the iOS project or
a config that stopped parsing, and nothing else. The compile is a fifth job
left commented out in the same file: it needs a macOS runner, it costs a runner
minute per push, and enabling it is uncommenting it. It invokes `xcodebuild
-project ios/App/App.xcodeproj`, not `-workspace` — Capacitor 8 generates a
Swift Package Manager project (`ios/App/CapApp-SPM` plus `Package.swift`) and
there is no `App.xcworkspace` to point at.

The smoke has no retries (`playwright.config.ts`, `retries: 0`) and no skip
path: `e2e/smoke.spec.ts`'s `beforeAll` asserts the gateway is answering and
fails with a message naming the address if it is not. That follows the backend's
own rule, stated in `docs/backend-architecture/12-test-strategy.md`: "A skip on
a missing daemon fails open: CI goes green on a runner whose Docker broke."

**All three smoke tests pass in CI. One of them fails on the development
machine, and it is left failing there.** CI is the authority on this, and it
says the client is fine: the `e2e` job builds the stack from the backend's
`main` on a clean runner and reports `3 passed`. What follows is a fact about
one host, recorded because that host is where the tests are usually run.

`demo browses, quotes, orders and cancels` gets as far as placing the order and
receives a Bad Gateway from the edge, because `ordering-api` is not running:
`deploy/compose/services/ordering.yml` makes it depend on `rabbitmq` being
healthy, and on this host RabbitMQ cannot bind 5672
or 15672 — a native `erl.exe` already holds them. That is an environment fact
about one machine rather than a defect in the client, and every step before the
order passes: sign-in, browsing, adding two products, quoting, reaching
checkout, filling the address form.

That test has a second failure mode worth telling apart from this one, because
both are environmental and they look nothing alike. If it fails EARLIER — at
`Total:`, with a `Method Not Allowed` banner on the cart — the running
`web-bff` container is older than backend PR #201: the quote became a POST in
that PR (ADR-045), this client sends POST, and an image built before it routes
only GET. `docker compose up -d --build web-bff` in the backend repository is
the fix, and `docker ps --format '{{.Image}} {{.CreatedAt}}'` is how to see it
coming. A 405 at the quote is a stale image; a Bad Gateway at the order is
RabbitMQ.

Marking it skipped would make the suite green on a machine where ordering does
not work — exactly the fail-open the rule above refuses. Leaving it red costs a
red run and states something true. The other two tests pass against the real
stack: a published product reaches the catalogue with no page reload (which is
what proves `CatalogRefresh`, rather than navigation, is doing the work), and
the `browser` user sees no Publish tab and is refused a direct navigation to
`/tabs/publish`, landing on `/tabs/account?denied=catalog:write` with the banner
that names the permission it lacks.

---

## 15. The native shell: one scheme, two origins, and a round trip nobody has run

Phase B adds Android and iOS around the same web build. Four facts about that
are worth writing down, because three of them are host decisions this client
only obeys and the fourth is a gap.

**The callback scheme is repeated in seven places, and none of them can
import another.** The realm's `mobile-app` client registers exactly one
redirect URI, `blueprint://auth/callback`
(`deploy/compose/keycloak/realm-export.json`), and Keycloak compares it as a
string. Every copy is an independent change point:

| Where | What it is for |
|---|---|
| `environment.ts`, `environment.development.ts`, `environment.android.ts` | `auth.nativeRedirectUri` — what the strategy actually sends. Three files, because each build configuration carries its own whole `Environment`. |
| `capacitor.config.ts` | the App plugin's `launchUrl` |
| `android/app/src/main/AndroidManifest.xml` | the intent filter that makes Android hand the return to this app |
| `ios/App/App/Info.plist` | `CFBundleURLTypes`, the same job on iOS |
| `deploy/compose/keycloak/realm-export.json` (backend repo) | the only redirect URI Keycloak will accept |

Seven is six too many and there is nowhere better to put it: three are
TypeScript here, two are native manifests, one is JSON in another repository.
The three environment files are the one group that could be collapsed — they
differ only in host — and they are not, because `Environment` is deliberately
one flat shape per build with no inheritance between them (§2). A scheme
change has to visit all seven, and a miss shows up as a sign-in that completes
in the browser and returns nowhere.

**The Android intent filter matches the host as well as the scheme.** `<data
android:scheme="blueprint" android:host="auth" />` rather than the scheme
alone, because the narrower filter is the one that matches the single redirect
URI the realm registers. The activity's generated
`android:launchMode="singleTask"` is what makes the return land in the running
task rather than in a second copy of the application — without it the returning
intent would start a fresh instance whose heap has no PKCE verifier in it, and
the exchange would fail for the same reason the web strategy's
`HybridOAuthStorage` exists to prevent on its own platform.

**A packaged native build is a different origin from the dev server.**
Capacitor serves the bundle from `https://localhost` on Android and
`capacitor://localhost` on iOS. The gateway's CORS list
(`deploy/compose/services/gateway.yml`, `Cors__Origins__*`) admits
`http://localhost:5173` — the Angular dev server — and neither native origin.
So a packaged build talking to the Compose stack is refused at the edge until
that origin is added, and this is a real deployment question rather than a
client defect: the spec does not cover it, and the fix belongs in the backend's
configuration next to the origin it already lists. Locally, adding
`https://localhost` as `Cors__Origins__1` is enough to test with. (The two
native origins are secure contexts, which is also why
`native-auth.strategy.ts` can rely on `crypto.subtle` for its S256 challenge;
jsdom has no `crypto.subtle` at all, which is why its spec stubs Node's
WebCrypto over it rather than asserting a stand-in digest.)

**The emulator reaches the host at `10.0.2.2`, not `localhost`.** Inside an
Android emulator `localhost` is the emulator. `environment.android.ts` carries
the host alias for the gateway and for Keycloak, and `ng build --configuration
android` (`npm run build:android`) is what selects it. Which environment a
build carries stays a build-time file replacement, as it is for the web: a
client that sniffed its own host would be deciding its configuration from the
thing the configuration is supposed to decide.

**Two things are known to block the first device run, and neither is fixed
here.** Both were found by review rather than by running anything, which is
itself the argument for running it.

*The token exchange is a browser `fetch`, and the realm grants it no origin.*
`native-auth.strategy.ts` posts to Keycloak's token endpoint with `fetch`,
which on a device is a request from the WebView's origin — `https://localhost`
on Android, `capacitor://localhost` on iOS. The realm's `mobile-app` client
declares `"webOrigins": []` (`realm-export.json`), so Keycloak returns no
`Access-Control-Allow-Origin` and the WebView discards the response before
this code sees it. Note this is a SEPARATE hop from the gateway CORS question
below: the gateway is not in this path at all, Keycloak is. Two ways out, and
they are not equivalent: add the native origins to the realm client (a backend
change, and the symmetrical fix to the gateway one), or enable Capacitor's
`CapacitorHttp` so `fetch` is serviced by the native HTTP stack and CORS never
applies. The second needs no backend change but patches `fetch` process-wide,
which would also reroute every `HttpClient` call to the gateway — not a change
to make without a device to check it on.

*The emulator configuration is cleartext, and the WebView is not.*
`environment.android.ts` points at `http://10.0.2.2:5000` and
`http://10.0.2.2:8080`, while Capacitor serves the page from `https://localhost`
— `androidScheme` defaults to `https` (`@capacitor/cli` declarations) and
`server.cleartext` defaults to `false`, with cleartext disabled outright from
API 28. So those requests are blocked twice over, as mixed content and as
cleartext, before either host is reached. The fixes are a config decision
rather than a typo: `androidScheme: 'http'` (localhost stays a secure context,
so `crypto.subtle` keeps working, but the origin the gateway must admit
changes again), `server.cleartext: true` — which Capacitor's own documentation
calls "not intended for use in production" — or TLS on the Compose stack.
Choosing without an emulator to verify against would be guessing.

**What has not been done.** No device or emulator has run this client. The
Android project builds a debug APK, the native strategy is covered by
thirty-nine unit tests with no device attached, and the iOS project is
generated — none of that is the same as a round trip through a real system
browser. Most of those thirty-nine exist because review found a bug, which is
worth noting: unit tests around a mocked `fetch` and a mocked browser can pin
every decision this class makes and still say nothing about the two things
below, because both are the platform refusing a request the mocks always
allow. Plan Task 20
is that round trip, and it is deliberately still open. Running it means, in
order:

1. Bring up the backend's Compose stack, and add `https://localhost` to the
   gateway's `Cors__Origins__*` as above.
2. `npm run build:android && npx cap sync android && npx cap run android`.
3. Sign in: the system browser must open (not a web view inside the app), and
   the return must land back in the running app rather than in a new copy of
   it.
4. Browse, quote, order, cancel — the same path `e2e/smoke.spec.ts` drives on
   the web.
5. Force-stop the app and relaunch: the cart must survive (Capacitor
   Preferences) and the session must survive too (the refresh token in secure
   storage), which is the one behaviour that differs from the web by design
   and the sentence the account page shows because of it.

Until somebody runs that, the honest claim about this client on a device is
that it compiles and its logic is tested, and nothing more.
