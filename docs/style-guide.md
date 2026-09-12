# Style guide

The dialect this repository is written in — prose, TypeScript and Angular
templates — and which rules a tool enforces rather than a reader.

**Read this before "correcting" anything.** The *Settled choices* table below
names the forms a reviewer, human or machine, reads as oversights. Every one
of them is deliberate, and a review finding that asks for one of them back is
answered by citing the row rather than by editing. `/style-pass` is how a
corrected form moves through the corpus, this file and the linters in one
change.

## What enforces what

Three files and a command, and they do not overlap. The question is never
"which one" but "which of these, and why not the others".

| | |
|---|---|
| `.prettierrc` | Layout Prettier owns outright: `printWidth: 100`, `singleQuote: true`, semicolons, trailing commas, and every wrapping decision in `.ts` and `.html` |
| `eslint.config.js` | Rules about the *program* rather than its layout: the import boundaries, the `app` selector prefixes, the Angular template accessibility set |
| `.editorconfig` | What an editor applies before either runs: UTF-8, two-space indent, final newline, trimmed trailing whitespace, and `quote_type = single` for `.ts` |
| this file | Everything none of the three can express — and it is most of what follows |

**Prettier is not in `npm run lint`, and nothing in CI checks formatting.**
`ng lint` runs ESLint only and `package.json` has no `format` script, so every
Prettier-owned rule below is enforced by editors and by review. That is a gap,
stated rather than assumed; wiring `npx prettier --check .` into the `web` job
would close it.

## Settled choices

The forms a reviewer flags most often. Each is a decision, not an oversight.

| Form | Why it is not arbitrary |
|---|---|
| **`inject()` at field level, never a constructor parameter** | It works in functional guards, interceptors and `provide*` factories, where there is no constructor at all — so one form covers every site instead of two |
| **Standalone components with an explicit `imports` array** | The array is the component's dependency list, readable without opening a module; there are no NgModules in this application to put it in |
| **`ChangeDetectionStrategy.OnPush` on every component** | The application is zoneless; `Default` there is a claim about change detection that nothing makes true |
| **Signals over `BehaviorSubject` for state** | `computed()` composes without a subscription to leak, and the templates read a signal by calling it. RxJS stays for HTTP and for genuine event streams |
| **Inline `template:` backtick strings, not `templateUrl`** | The component and its markup are one unit and one diff; the comments that argue a template's shape sit inside it, where a `.html` file could not carry them |
| **A `private` signal, exposed through `asReadonly()`** | The prevailing form across `core/` and the pages. The writer is the class's own business and the reader is everybody's; one field carrying both is how a template ends up able to set state |
| **`readonly` on every interface field carrying wire data** | A wire type is a record of what the server said. A client that mutates one has lost the ability to say what it was told |
| **Path aliases `@core/`, `@shared/`, `@features/`** | They are `tsconfig.json`'s `paths` and they are what `eslint.config.js` restricts. A deep relative import is the spelling the boundary rules cannot see |
| **Relative imports *within* one area** | `./cart.persistence` from inside `core/cart/` says "my own neighbour"; `@core/cart/cart.persistence` from the same directory says nothing more and reads as a cross-area import |
| **British prose with literal dashes, and identifiers left alone** | `behaviour` in a sentence, `ChangeDetectionStrategy` in code. An identifier is a name, not a word to be corrected |

**`src/app/app.ts` is the one exception to both of the rules above, and it is
an exception rather than an oversight.** It is the bootstrapped root shell: it
carries no `changeDetection` and so runs Angular's default strategy, and it is
the only component in `src/` using `templateUrl`. Verified by grep, in both
directions — it is the only component without `OnPush` and the only one with a
`templateUrl`. Bringing it into line is a change to `src/`, which no document
may make on its own account; until somebody decides, a reviewer flagging it is
reporting a known exception rather than a defect. A guide that contradicts
the code it governs is a guide nobody can apply, which is why this is
written down rather than left to be rediscovered.

## Prose

- **Wraps at 80 columns.** Tables, links and code fences may exceed it.
- **British spelling**, and literal `—` and `…` rather than escapes.
- **Cite by name, never by value** — this is
  [`change-locality.md`](change-locality.md) §2, and it is the rule most often
  broken by a well-meaning edit. Name the symbol or the section; do not repeat
  the number.
- **A reference of the form "spec §5.2"** points at
  `docs/superpowers/specs/2026-09-10-blueprint-frontend-design.md`. A
  reference of the form "§11.4" alone, quoted from a code comment, is the
  *backend's* chapter number.
  [`client-architecture.md`](client-architecture.md)'s header owns that
  distinction; do not restate it in a third place.

## TypeScript

- **100 columns**, single quotes, semicolons, trailing commas — Prettier's,
  all four, so do not argue them in a review.
- **Two-space indent**, every continuation a multiple of two.
- **`const` by default**, `let` only where the binding is reassigned, `var`
  never.
- **Explicit return types on exported functions and public methods.** A reader
  of a fenced code block has no hover and no go-to-definition, and half this
  repository's samples live in fenced blocks.
- **`interface` for a shape, `type` for a union or an alias.** A wire type is
  an interface; `DisplayError`'s discriminated union is a type.
- **No `any`.** `unknown` plus a narrowing check where the shape is genuinely
  unknown — which, for anything arriving over HTTP, it is.
- **No non-null assertion (`!`) on a value the server supplied.** The server
  is allowed to disappoint you; say so with a check.
- **A single statement may omit braces; two or more always take them, and so
  does one that wraps.**
- **`private` for internals.** For a member the template reads, the corpus
  does two things — plain `readonly` in `products.page.ts`, `protected
  readonly` in `cart.page.ts`, `checkout.page.ts`, `publish.page.ts`,
  `tabs.page.ts` and `error-banner.component.ts` — and **this is an open
  question rather than a settled choice.** `protected` is the better of the
  two: `strictInjectionParameters` and `strictInputAccessModifiers` are both
  on, templates compile against `protected`, and it says the member exists
  for the template and is not part of the class's API. Settling it is a
  `/style-pass`, and until somebody runs one, match the file you are in
  rather than converting it.

## Angular

- **Selectors are `app-` kebab-case for components and `app` camelCase for
  directives.** `eslint.config.js` enforces both; a component without the
  prefix fails lint rather than review.
- **A feature never imports another feature, and `core` knows nothing about
  screens.** This is spec §3, enforced coarsely by `no-restricted-imports` and
  precisely by `src/app/core/boundaries.spec.ts` — read that file's comment
  before concluding the rule over-fires, because it says exactly where it does.
- **Shared state belongs in `core/`.** `CartStore` lives there because the
  products page writes it and the cart and checkout pages read it; that
  sharing is the reason, and it is the test for any future candidate.
- **Templates call signals** — `error()`, not `error`. A signal read as a
  property is a function reference rendering as `[object Function]`, and it
  fails silently.
- **New control flow** (`@if`, `@for`, `@switch`), not `*ngIf` and `*ngFor`.
- **A comment inside a template argues the markup**, in an HTML comment, in
  the same voice as the code around it. `products.page.ts` is the model.

## Comments

- **A JSDoc block on an exported symbol says why it exists**, and cites the
  spec section or the `client-architecture.md` argument it answers. `CartStore`
  and `ProductsPage` both open this way; match them.
- **A line comment argues the non-obvious.** The long comments in
  `cart.store.ts` about the persistence effect and object identity are the
  house form: state the failure the code is written against, and how it was
  observed, so the next reader cannot delete the guard by accident.
- **Never comment what the line says.** `// increment i` is noise; `// the
  effect is SCHEDULED at construction, not run there` is the file's value.

## Tests

- **Vitest**, with `describe` / `it` / `expect` / `vi` imported explicitly —
  no globals. `beforeEach` builds the `TestBed`.
- **A factory for fixture data at the top of the file**, as
  `cart.store.spec.ts` has for `ProductSummary`. A literal repeated five times
  hides which field the test is actually about.
- **One behaviour per `it`, named as a sentence about the behaviour** — not
  `it('works')`.
- **A test a do-nothing implementation would satisfy is a defect**, ranked
  critical by `/bug-sweep`. Assert the thing that would be wrong, not that
  nothing threw.
- **`.spec.ts` beside the file it covers**, always, and in the same PR.
  `e2e/` is Playwright's and is a different suite with different prerequisites
  — [`testing.md`](testing.md) owns those.

## No setting expresses these

Kept here so a reviewer does not go hunting for a key that does not exist:

- the 80-column prose wrap — Prettier does not format Markdown prose here, and
  `.editorconfig` sets `max_line_length = off` for `.md` deliberately, because
  a table cannot honour it;
- British spelling, and the identifier carve-out from it;
- `inject()` over constructor parameters;
- the JSDoc-cites-a-spec-section rule;
- "shared state belongs in `core/`" as a *judgement*; only its mechanical
  half — the import direction — is a lint rule.

Adding a rule to this section is a legitimate outcome of `/style-pass` §4 and
is preferable to inventing an option name: Prettier fails closed on an unknown
key and ESLint on an unknown rule, so an invented one breaks `npm run lint`
for everybody rather than being ignored.
