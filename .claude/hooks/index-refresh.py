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

**One worker per root, and edits made while it runs are coalesced, not
dropped.** A detached refresh per edit raced: two edits inside the first
build's five seconds both saw no index and both ran `index`, and later edits
ran overlapping `update`s against one SQLite cache. Raised by Copilot. So the
hook takes a lock file beside the index before it spawns anything; an edit that
finds the lock held leaves a `pending` marker instead, and the worker runs one
more `update` for every marker it finds when a run finishes. The worker removes
the lock and then looks for a marker once more, and the hook looks for the lock
once more after leaving one, so an edit that lands between the two checks is
still refreshed. The worker renews the lock before every run, so a lock older
than any one run could take is a crashed worker's and is taken over; its token
keeps a worker from removing a lock it no longer holds.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import time
import uuid

# The prefix both sweeps give their throwaway worktrees.
SWEEP_PREFIX = "secsweep-"

WRAPPER = os.path.join(".claude", "skills", "codebase-index", "scripts", "run-index")

CACHE = os.path.join(".claude", "cache", "codebase-index")

# A refresh is killed after this long, so a lock older than it is abandoned.
RUN_TIMEOUT = 300
STALE_AFTER = RUN_TIMEOUT + 60

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


def registered(toplevel, owner_toplevel):
    """Whether `toplevel` is a checkout git itself made of this repository.

    **The common directory is a claim the checkout makes about itself.** A
    directory holding a `.git` file that names `<repo>/.git/worktrees/x`, or a
    `.git` that is a junction to `<repo>/.git`, reports this repository's
    common directory without git ever having created it, and its files would
    be indexed by this checkout's tooling. Raised by Copilot. So a `.git`
    file must be one its admin directory points back at — the backlink
    `guard-edit-target.py`'s `verified_gitdir` requires for the same reason —
    and a `.git` directory is only ever the owner's own checkout.
    """
    marker = os.path.join(toplevel, ".git")
    if os.path.isdir(marker):
        return same(toplevel, owner_toplevel)
    if not os.path.isfile(marker):
        return False
    try:
        with open(marker, encoding="utf-8") as handle:
            text = handle.read().strip()
    except OSError:
        return False
    if not text.startswith("gitdir:"):
        return False
    gitdir = os.path.join(toplevel, text.split(":", 1)[1].strip())
    try:
        with open(os.path.join(gitdir, "gitdir"), encoding="utf-8") as handle:
            backlink = handle.read().strip()
    except OSError:
        return False
    return same(backlink, marker)


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
    if not registered(toplevel, mine[0]):
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
    built = os.path.join(root, CACHE, "index.sqlite")
    return "update" if os.path.isfile(built) else "index"


def lock_path(root):
    return os.path.join(root, CACHE, "refresh.lock")


def pending_path(root):
    return os.path.join(root, CACHE, "refresh.pending")


def acquire(root):
    """Take the root's refresh lock: the holder's token, or None when it is held.

    **The lock carries a token, and only its holder renews or removes it.**
    Its age used to be measured from creation alone, so a worker serving
    several coalesced refreshes looked abandoned after the first ran long, a
    second worker took the lock over, and the first then deleted the
    replacement's lock on its way out. Raised by Copilot. The worker now
    renews the lock before every refresh, so a live lock is never older than
    one run, and `release` removes only a lock whose token is its own.
    """
    lock = lock_path(root)
    os.makedirs(os.path.dirname(lock), exist_ok=True)
    for _ in range(2):
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            try:
                if time.time() - os.path.getmtime(lock) < STALE_AFTER:
                    return None
                os.remove(lock)
            except OSError:
                return None
            continue
        token = uuid.uuid4().hex
        os.write(fd, token.encode("ascii"))
        os.close(fd)
        return token
    return None


def holds(root, token):
    try:
        with open(lock_path(root), encoding="ascii") as handle:
            return handle.read().strip() == token
    except (OSError, UnicodeDecodeError):
        return False


def renew(root, token):
    """Refresh the lock's age before a run; False when this worker lost it."""
    if not holds(root, token):
        return False
    try:
        os.utime(lock_path(root))
    except OSError:
        return False
    return True


def release(root, token):
    if holds(root, token):
        try:
            os.remove(lock_path(root))
        except OSError:
            pass


def take_pending(root):
    """Consume the root's pending marker; True when there was one."""
    try:
        os.remove(pending_path(root))
        return True
    except OSError:
        return False


def mark_pending(root):
    with open(pending_path(root), "a", encoding="ascii"):
        pass


def refresh(owner, root):
    """Run the owner's wrapper against `root` once, synchronously."""
    bash = shutil.which("bash")
    if bash is None:
        return
    try:
        subprocess.run(
            [bash, os.path.join(owner, WRAPPER), "--quiet", "--root", root,
             subcommand(root)],
            cwd=owner, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, timeout=RUN_TIMEOUT, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        pass


def work(owner, root, token):
    """The worker: refresh until no edit is left waiting, then let go."""
    while True:
        if not renew(root, token):
            return
        take_pending(root)
        refresh(owner, root)
        if take_pending(root):
            continue
        release(root, token)
        # An edit that found the lock held just before it was released left a
        # marker this loop has not seen; take the lock back and serve it.
        if not take_pending(root):
            return
        token = acquire(root)
        if token is None:
            return


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


def launch(owner, root, token):
    try:
        spawn([sys.executable, os.path.abspath(__file__), "--worker", root, token], owner)
    except OSError:
        release(root, token)


def start(owner, root):
    """Hand `root` to a worker: a new one if the lock is free, else a marker."""
    token = acquire(root)
    if token is not None:
        launch(owner, root, token)
        return
    mark_pending(root)
    # The worker may have released between the failed acquire and the marker.
    token = acquire(root)
    if token is not None:
        launch(owner, root, token)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    owner = home()
    if argv[:1] == ["--worker"]:
        # Spawned by `start`, which already holds the lock. The root is judged
        # again rather than trusted, so the worker entry point widens nothing,
        # and a token of any other shape is not one `acquire` wrote.
        if len(argv) != 3 or not re.fullmatch(r"[0-9a-f]{32}", argv[2]):
            return 0
        root = target_root(argv[1], owner)
        if root is not None:
            work(owner, root, argv[2])
        return 0
    try:
        event = json.load(sys.stdin)
    except (ValueError, UnicodeDecodeError):
        return 0
    if not isinstance(event, dict):
        return 0
    root = target_root(event.get("cwd"), owner)
    if root is None or shutil.which("bash") is None:
        return 0
    try:
        start(owner, root)
    except OSError:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
