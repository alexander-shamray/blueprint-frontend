# Command Reference

Load this reference only when the intent table in `SKILL.md` is insufficient.

## Retrieval

```bash
bash .claude/skills/codebase-index/scripts/run-index search "<query>" --limit 3 --session <tag> --json
bash .claude/skills/codebase-index/scripts/run-index explain "<topic or flow>" --session <tag> --json
```

Useful search options:

- `--mode hybrid|fts|symbol|vector`
- `--token-budget <tokens>`
- `--limit <count>` — **pass `--limit 3`**; the default is ten and the
  evidence protocol opens the first three (`SKILL.md`)
- `--offset <pagination offset>`
- `--raw` to disable snippet skeletonization
- `--no-fallback` to suppress fallback suggestions
- `--session <tag>` to name this conversation's context: unchanged evidence it
  already received comes back as `reused: true` without the snippet, and
  evidence that changed is listed under `memory.invalidated`

`explain` uses the HOW_IT_WORKS intent and a larger default token budget. Prefer
it over repeatedly rewording a broad search.

## Code graph

```bash
bash .claude/skills/codebase-index/scripts/run-index architecture --json
bash .claude/skills/codebase-index/scripts/run-index refs "<symbol>" --json
bash .claude/skills/codebase-index/scripts/run-index impact "<file-or-symbol>" --direction up --depth 2 --json
bash .claude/skills/codebase-index/scripts/run-index diff-impact --base HEAD --direction up --depth 2 --json
bash .claude/skills/codebase-index/scripts/run-index path "<source>" "<target>" --json
bash .claude/skills/codebase-index/scripts/run-index describe "<file-or-symbol>" --json
```

- `architecture` reads module analysis cached at index time.
- `refs` finds definitions, calls, and graph-backed references.
- `impact` walks dependents (`up`), dependencies (`down`), or both.
- `diff-impact` aggregates impact for tracked changes relative to a verified
  Git commit; new or excluded files are reported as unresolved.
- `path` returns the shortest known dependency/call chain.
- `describe` returns a node card with callers, callees, module, and centrality.

Use `graph` only for a visualization intended for a person:

```bash
bash .claude/skills/codebase-index/scripts/run-index graph "<target>" --direction both --depth 2 --output graph.html
```

For headless work, use `--output`; do not use `--open`. Exports also support
`--format graphml|dot|neo4j`.

## Evidence

```bash
bash .claude/skills/codebase-index/scripts/run-index verify --session <tag> --json
bash .claude/skills/codebase-index/scripts/run-index verify "<path:start-end@hash>" ... --json
```

- `verify` is read-only and needs no index: it checks evidence against the
  working tree. `all_valid` is true only when every checked span still holds.
- `--strict` exits 1 when anything is invalid (useful in scripts).
- See [memory.md](memory.md) for verdict states and when to reread.

## Index health

```bash
bash .claude/skills/codebase-index/scripts/run-index stats --json
bash .claude/skills/codebase-index/scripts/run-index doctor
bash .claude/skills/codebase-index/scripts/run-index update
bash .claude/skills/codebase-index/scripts/run-index index
```

Run `stats` and `doctor` when several unrelated queries have low confidence.
Low symbol counts or partial graph coverage can explain weak results.

## Query examples

```bash
bash .claude/skills/codebase-index/scripts/run-index search "auth token refresh" --limit 3 --session <tag> --json
bash .claude/skills/codebase-index/scripts/run-index search "AuthService class" --mode symbol --limit 3 --session <tag> --json
bash .claude/skills/codebase-index/scripts/run-index search "connection reset by peer" --mode fts --limit 3 --session <tag> --json
bash .claude/skills/codebase-index/scripts/run-index explain "checkout flow" --session <tag> --json
bash .claude/skills/codebase-index/scripts/run-index impact "User" --direction up --depth 2 --json
bash .claude/skills/codebase-index/scripts/run-index path "ApiController" "Database" --json
```
