#!/usr/bin/env python3
"""Refresh the index of the checkout an edit landed in, not the one the session started in.

**The refresh followed `CLAUDE_PROJECT_DIR`, and `/branch` moves the session
away from it (alexander-shamray/blueprint-frontend#48).** The `PostToolUse`
entry used to be `cd "${CLAUDE_PROJECT_DIR}" && run-index update`, which
anchored the wrapper safely and indexed the wrong tree: after `/branch` enters
a sibling worktree, every edit refreshed the startup checkout, which the edit
never touched, and the worktree's own index went stale — the staleness #44 set
out to remove.

**Two halves, and only one of them moved.** The *wrapper* still comes from this
file's own checkout — the one `settings.json` names through
`CLAUDE_PROJECT_DIR`, where `.claude/skills/**` and `.claude/hooks/**` are
edit-denied — so no tree the session is standing in chooses the code that runs.
The *root* now comes from the event's `cwd`, walked up to its checkout, and is
handed to that trusted wrapper as `--root`.

**The root is taken only when it is this repository's own worktree, and never
a sweep's.** `git rev-parse --git-common-dir` there must resolve to this
checkout's common directory, so a `cwd` in an unrelated repository — or in no
repository — refreshes nothing. And a checkout whose directory starts
`secsweep-` is refused by name: `/security-sweep` and `/bug-sweep` detach their
worktrees under that prefix, `docs/harness-boundaries.md` calls the tree they
hold prompt-injection input, and indexing it would read that tree's
`.codeindexignore` and config with this checkout's tooling. It is the same
prefix `git-worktree-detach.sh` and `git-worktree-drop.sh` bind to.

**Silent, detached and always exit 0.** The command this replaces backgrounded
itself and discarded its output, because a refresh that fails is a stale index
rather than a broken edit. `&` in the hook command is not available here: a
backgrounded job in a non-interactive shell gets `/dev/null` for stdin, and the
event arrives on stdin. So this file reads the event, decides, starts the
refresh as a detached process with every stream closed, and returns at once.
"""

import json
import os
import shutil
import subprocess
import sys

# The prefix both sweeps give their throwaway worktrees.
SWEEP_PREFIX = "secsweep-"

WRAPPER = os.path.join(".claude", "skills", "codebase-index", "scripts", "run-index")

# `git` must answer about the directory it is pointed at and nothing else.
GIT_ENV_OVERRIDES = ("GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE")


def home():
    """The checkout this hook belongs to: three directories above this file."""
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def same(a, b):
    return os.path.normcase(os.path.realpath(a)) == os.path.normcase(os.path.realpath(b))


def git_paths(directory):
    """`(toplevel, common_dir)` for the checkout holding `directory`, or None."""
    env = {k: v for k, v in os.environ.items() if k not in GIT_ENV_OVERRIDES}
    try:
        out = subprocess.run(
            ["git", "-C", directory, "rev-parse", "--show-toplevel", "--git-common-dir"],
            capture_output=True, text=True, timeout=3, env=env, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    lines = out.stdout.splitlines()
    if out.returncode != 0 or len(lines) != 2 or not all(lines):
        return None
    toplevel, common = lines
    # `--git-common-dir` is relative to `directory` when git prints it relative.
    return toplevel, os.path.join(directory, common)


def target_root(cwd, owner):
    """The root to refresh for an edit made from `cwd`, or None to refresh nothing."""
    if not isinstance(cwd, str) or not cwd or not os.path.isdir(cwd):
        return None
    target = git_paths(cwd)
    mine = git_paths(owner)
    if target is None or mine is None:
        return None
    toplevel, common = target
    if not same(common, mine[1]):
        return None
    if os.path.basename(os.path.normpath(toplevel)).startswith(SWEEP_PREFIX):
        return None
    return os.path.normpath(toplevel)


def subcommand(root):
    """`update` where an index exists, `index` where none has been built yet.

    **A fresh worktree has no index, and `update` there does nothing** — it
    prints *No index found* and exits. `/branch` forks a new worktree for every
    PR, so following the active worktree with `update` alone would have moved
    the refresh to a tree it can never refresh. A full build of this repository
    took about five seconds and eight megabytes when measured, and it runs
    detached, so the first edit in a worktree pays for it once.
    """
    built = os.path.join(root, ".claude", "cache", "codebase-index", "index.sqlite")
    return "update" if os.path.isfile(built) else "index"


def spawn(argv, cwd):
    """Start `argv` detached from this hook, with no stream left open to it."""
    kwargs = {
        "cwd": cwd,
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "close_fds": True,
    }
    if os.name == "nt":
        kwargs["creationflags"] = (
            subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP)
    else:
        kwargs["start_new_session"] = True
    subprocess.Popen(argv, **kwargs)


def main():
    try:
        event = json.load(sys.stdin)
    except (ValueError, UnicodeDecodeError):
        return 0
    if not isinstance(event, dict):
        return 0
    owner = home()
    root = target_root(event.get("cwd"), owner)
    bash = shutil.which("bash")
    if root is None or bash is None:
        return 0
    try:
        spawn([bash, os.path.join(owner, WRAPPER), "--quiet", "--root", root,
               subcommand(root)], owner)
    except OSError:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
