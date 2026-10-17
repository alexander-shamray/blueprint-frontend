#!/usr/bin/env python3
"""Refuse to run the code-index CLI over an index the refresh hook would not open.

**`run-index` and `cbx` are the skill's direct route to the index, and they
opened it with none of the hook's judgement
(alexander-shamray/blueprint-frontend#138).** A branch can force-track files
under `.claude/cache/codebase-index/`, and a checkout writes them over the
ignored ones. The first connection to a rollback-mode database replays a
`-journal` it finds beside it, and that replay acts on what the journal says,
which the branch wrote; a link at a sidecar sends SQLite's writes wherever it
points. `index_openable` in `index-refresh.py` is the judgement for exactly
these, so this file asks it rather than keeping a second copy of the rule.

**The root is asked of git and of the working directory both**, because the
CLI resolves its root from the directory it is run in and this cannot see
which of the two it will take. A directory with no index yet is admitted, as
`index_openable` admits a root with none. Outside a git checkout there is
nothing to judge and the CLI runs. Exit 3 is a refusal; 0 lets the CLI run.

The hook is loaded without writing bytecode: a `__pycache__` under
`.claude/hooks/` would be one more file whose contents decide what a guard
does. `mcp-launch.mjs` runs this file before it starts the MCP server, so that route
is judged too; `docs/harness-boundaries.md` owns the window that remains.
"""

import importlib.util
import os
import subprocess
import sys

HOOK = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "hooks", "index-refresh.py")


def toplevel():
    """The checkout the working directory sits in, or None outside one."""
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"], capture_output=True,
            encoding="utf-8", errors="replace", timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    line = out.stdout.strip()
    return line if out.returncode == 0 and line else None


def main():
    sys.dont_write_bytecode = True
    roots = [os.getcwd()]
    top = toplevel()
    if top is not None:
        roots.append(top)
    spec = importlib.util.spec_from_file_location("index_refresh", HOOK)
    hook = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(hook)
    for root in dict.fromkeys(os.path.normpath(root) for root in roots):
        if not hook.index_openable(root):
            print(f"gate-index: refusing to open the index under {root}: a link on its path, a "
                  "rollback journal beside it, or a header that is not WAL mode. Remove what the "
                  "branch tracked under .claude/cache/codebase-index/ and run it again.",
                  file=sys.stderr)
            return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
