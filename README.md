# blueprint-frontend

The reference client for [`dotnet-ddd-blueprint`](https://github.com/alexander-shamray/dotnet-ddd-blueprint)
— an Angular 22 / Ionic 9 / Capacitor application that consumes the platform
rather than demonstrating a framework.

It exists to answer a question the backend cannot answer about itself: *what
does a client that takes this platform seriously actually have to do?* Anonymous
browsing, permissions as claims, idempotent commands held across a failure,
three different 409s that mean three different things, and a quote whose total
the client is forbidden to recompute.

**Phase A (this branch) is the web client.** Phase B adds Capacitor, native
auth and the mobile builds.

## Running it

The client talks only to the gateway, and the gateway is in the backend
repository. Start the platform first:

```bash
git clone https://github.com/alexander-shamray/dotnet-ddd-blueprint.git
cd dotnet-ddd-blueprint
docker compose -f deploy/compose/docker-compose.yml up -d --wait
```

Then, in this repository:

```bash
npm ci
npm start
```

**Open `http://localhost:5173/`, not 4200.** The port is not a preference: it is
the origin Keycloak's realm lists in `web-app`'s `redirectUris` and
`webOrigins`, and the one the gateway allows through CORS. On any other port the
application loads and sign-in fails, because the identity provider will not
redirect back to an origin it does not know.

Sign in with either realm user:

| User | Password | Holds |
|---|---|---|
| `demo` | `demo` | `catalog:write`, `orders:write`, `orders:cancel` |
| `browser` | `browser` | nothing |

`browser` is not a degraded account — it is the point of §4.3. The Publish tab
is absent for it, and navigating to that route directly is refused with the
permission named. A hidden button and a refused route are two different facts,
and the client demonstrates both.

## What talks to what

| Piece | Where |
|---|---|
| Gateway (everything the client calls) | `http://localhost:5000` |
| Keycloak | `http://localhost:8080/realms/commerce` |
| This app | `http://localhost:5173` |

Configuration lives in `src/app/core/config/`, and every value there carries a
comment naming the backend file or realm setting that fixes it.

## Testing

```bash
npm test                                        # 157 unit and component tests
npm run lint
npm run build
npm run e2e                                     # Playwright, needs the stack up
```

The e2e smoke runs against the real Compose stack and is never skipped when the
platform is missing — it fails on connection instead. The backend's own rule is
that a skip fails open, and a smoke that reports green with nothing running is
worth less than no smoke.

## Reading it

`docs/client-architecture.md` is the document to read after this one. It takes
each backend decision the client can observe, cites the file or realm setting
that forces it, and names where in this client it shows up. Its last section is
the one worth your time if you already know the backend: the assumptions this
client had to abandon, and what each cost.

Two examples of the shape of that list. The catalogue's listing is anonymous, so
Products is the landing tab and works signed out — which sounds obvious until
you notice that a client demanding a token there would be refusing to show what
the platform publishes. And a product may legally cost nothing, so a client that
tested a price for truthiness would hide a free product; this one tests for
`undefined`.

`docs/superpowers/plans/2026-09-10-blueprint-frontend.md` is the implementation
plan, kept in sync with what shipped. Where the plan was wrong, the commit that
corrected it says so.
