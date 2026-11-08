# AGENTS.md

This repository's agent guidance is maintained in [CLAUDE.md](CLAUDE.md),
which imports [.harness/agent-rules.md](.harness/agent-rules.md), the rules
every repository on the shared harness holds. Read both before making any
change, then read the document they name for the area you intend to touch.

The operating contract is [docs/change-locality.md](docs/change-locality.md).
Name the change class and touch set before editing; do not widen either
without recording why. Existing uncommitted changes belong to the user unless
they are clearly part of the requested work.

In particular:

- Treat code and tests as the source of truth for facts.
- Preserve the feature-to-feature and core-to-screen import boundaries.
- Use `npm ci`, never `npm install`; run the smallest relevant check before
  handing work over.
- Read the section of `docs/harness-boundaries.md` its index names before
  touching `.claude/`. A managed file, any path `.harness/manifest.json`
  lists, is changed in `blueprint-harness`, never here.

Do not edit `.remember/` or delivery records under `docs/superpowers/plans/`.
