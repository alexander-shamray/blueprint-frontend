# AGENTS.md

This repository's agent guidance is maintained in [CLAUDE.md](CLAUDE.md).
Read it before making any change, then read the document it names for the
area you intend to touch.

The operating contract is [docs/change-locality.md](docs/change-locality.md).
Name the change class and touch set before editing; do not widen either
without recording why. Existing uncommitted changes belong to the user unless
they are clearly part of the requested work.

In particular:

- Treat code and tests as the source of truth for facts.
- Preserve the feature-to-feature and core-to-screen import boundaries.
- Use `npm ci`, never `npm install`; run the smallest relevant check before
  handing work over.
- Read `docs/harness-boundaries.md` before touching `.claude/`.

Do not edit `.remember/` or delivery records under `docs/superpowers/plans/`.
