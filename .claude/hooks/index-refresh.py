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
ran overlapping `update`s against one SQLite cache. Raised by Copilot. Every
edit leaves a `pending` marker beside the index, and a worker holding the
root's lock runs one more refresh for as long as it finds one; an edit that
finds the lock held starts nothing, because the worker will see its marker.
The edit marks before it looks at the lock, and the worker looks for a marker
once more after it lets go, so the edit landing between those two steps is
still served by one side or the other.

**The lock is the operating system's, held for the worker's lifetime.** It
began as a lock *file* whose existence was the lock, which needed an age to
tell a crashed worker from a live one — and then a token, a renewal, and a
check-then-act on every renewal and removal that a takeover could still slip
between. Raised by Copilot across two rounds. An advisory lock on an open
handle (`flock` on POSIX, `msvcrt.locking` on Windows) has none of that: the
kernel grants it to one process, and releases it the moment that process
exits, crashed or not. The file itself is never removed, so no path operation
can pull a lock out from under its holder.
"""

import json
import os
import shutil
import subprocess
import sys
import time

if os.name == "nt":
    import msvcrt
else:
    import fcntl

# The prefix both sweeps give their throwaway worktrees.
SWEEP_PREFIX = "secsweep-"

WRAPPER = os.path.join(".claude", "skills", "codebase-index", "scripts", "run-index")

CACHE = os.path.join(".claude", "cache", "codebase-index")

# A refresh that has not finished by now is killed, so a worker never hangs.
RUN_TIMEOUT = 300

# Every git call one event makes shares this many seconds, well inside the
# five `settings.json` gives the hook.
GIT_BUDGET = 3

# `git` must answer about the directory it is pointed at and nothing else.
GIT_ENV_OVERRIDES = ("GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE")


def home():
    """The checkout this hook belongs to: three directories above this file."""
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def same(a, b):
    return os.path.normcase(os.path.realpath(a)) == os.path.normcase(os.path.realpath(b))


def git_paths(directory, deadline):
    """`(toplevel, common_dir)` for the checkout holding `directory`, or None.

    `deadline` is a `time.monotonic()` instant shared by every git call one
    event makes, so the calls between them stay inside the hook's own
    timeout. Two calls each allowed three seconds could outlast the five
    `settings.json` gives the hook, which would be killed before it spawned
    anything. Raised by Copilot.
    """
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        return None
    env = {k: v for k, v in os.environ.items() if k not in GIT_ENV_OVERRIDES}
    try:
        out = subprocess.run(
            ["git", "-C", directory, "rev-parse", "--show-toplevel", "--git-common-dir"],
            capture_output=True, text=True, timeout=remaining, env=env, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    lines = out.stdout.splitlines()
    if out.returncode != 0 or len(lines) != 2 or not all(lines):
        return None
    toplevel, common = lines
    # `--git-common-dir` is relative to `directory` when git prints it relative.
    return toplevel, os.path.join(directory, common)


def registered(toplevel, owner_toplevel, owner_common):
    """Whether `toplevel` is a checkout git itself made of this repository.

    **The common directory is a claim the checkout makes about itself.** A
    directory holding a `.git` file that names `<repo>/.git/worktrees/x`, or a
    `.git` that is a junction to `<repo>/.git`, reports this repository's
    common directory without git ever having created it, and its files would
    be indexed by this checkout's tooling. Raised by Copilot. So a `.git`
    file must be one its admin directory points back at — the backlink
    `guard-edit-target.py`'s `verified_gitdir` requires for the same reason —
    and a `.git` directory is only ever the owner's own checkout.

    **And the marker must be a real entry, not a link to one.** `isfile`,
    `open` and `realpath` all follow a link, so a forged directory whose
    `.git` linked to a registered worktree's `.git` file read that file's
    admin directory, whose backlink named that same file, and passed. Raised
    by Copilot. A link or junction at `.git` is refused before either branch.

    **And the admin directory must be one of this repository's.** A backlink
    proves only that the admin directory agrees with the marker, and an
    attacker who writes the marker can write the admin directory too: a
    `gitdir` pointing back and a `commondir` naming this repository, anywhere
    on disk. Raised by Copilot. `guard-edit-target.py` requires the admin
    directory beneath the owner's `.git`, and so does this: git keeps every
    worktree's under `<common>/worktrees/`, and nowhere else.
    """
    marker = os.path.join(toplevel, ".git")
    if os.path.islink(marker) or os.path.isjunction(marker):
        return False
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
    worktrees = os.path.normcase(os.path.realpath(os.path.join(owner_common, "worktrees")))
    admin = os.path.normcase(os.path.realpath(gitdir))
    if os.path.dirname(admin) != worktrees:
        return False
    try:
        with open(os.path.join(gitdir, "gitdir"), encoding="utf-8") as handle:
            backlink = handle.read().strip()
    except OSError:
        return False
    return same(backlink, marker)


def swept(toplevel):
    """Whether `toplevel` is a sweep's checkout, whatever case spells it.

    Folded, because the filesystems this runs on mostly fold case: on Windows
    and macOS `SECSWEEP-x` is the same directory name as `secsweep-x`, and a
    case-sensitive comparison let the one through that the other refused.
    Raised by Copilot.
    """
    return os.path.basename(os.path.normpath(toplevel)).casefold().startswith(
        SWEEP_PREFIX)


def target_root(cwd, owner):
    """The root to refresh for an edit made from `cwd`, or None to refresh nothing."""
    if not isinstance(cwd, str) or not cwd or not os.path.isdir(cwd):
        return None
    deadline = time.monotonic() + GIT_BUDGET
    target = git_paths(cwd, deadline)
    mine = git_paths(owner, deadline)
    if target is None or mine is None:
        return None
    toplevel, common = target
    if not same(common, mine[1]):
        return None
    if not registered(toplevel, mine[0], mine[1]):
        return None
    if swept(toplevel):
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


class Lock:
    """The root's refresh lock: an OS advisory lock on an open handle.

    Held from `acquire` until `release` or the process's exit, whichever is
    first, and by one process at a time. Windows locks a byte range per
    handle, POSIX `flock` locks per open file, and in both a second handle in
    the same process is refused like any other, which is what lets the suite
    hold it from a test.
    """

    def __init__(self, root):
        self.path = lock_path(root)
        self.handle = None

    def acquire(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        handle = open(self.path, "a+b")
        try:
            if os.name == "nt":
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            handle.close()
            return False
        self.handle = handle
        return True

    def release(self):
        if self.handle is None:
            return
        try:
            if os.name == "nt":
                self.handle.seek(0)
                msvcrt.locking(self.handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(self.handle.fileno(), fcntl.LOCK_UN)
        finally:
            self.handle.close()
            self.handle = None


def held(root):
    """Whether a worker holds the root's lock right now."""
    probe = Lock(root)
    if not probe.acquire():
        return True
    probe.release()
    return False


def take_pending(root):
    """Consume the root's pending marker; True when there was one.

    **Removing a marker an edit is still creating loses nothing, because the
    marker never carries the edit.** The hook runs after the edit is on disk,
    and the worker removes a marker only as the first step of a refresh. So
    whoever unlinks it — even out from under an edit whose `open` has not yet
    closed — goes on to refresh a tree that already holds that edit. On
    Windows the unlink of an open file fails instead, and the marker survives
    for the next look. Raised by Copilot as a lost edit; it is a lost marker,
    which the refresh after it makes redundant.
    """
    try:
        os.remove(pending_path(root))
        return True
    except OSError:
        return False


def mark_pending(root):
    os.makedirs(os.path.dirname(pending_path(root)), exist_ok=True)
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


def work(owner, root):
    """The worker: refresh while an edit is waiting, then let go.

    A second worker for the same root finds the lock held and returns at
    once. After letting go the worker looks for a marker once more: an edit
    that marked while it still held the lock saw it held and started nothing,
    so this look is what serves it.
    """
    lock = Lock(root)
    while lock.acquire():
        try:
            while take_pending(root):
                refresh(owner, root)
        finally:
            lock.release()
        if not os.path.exists(pending_path(root)):
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


def start(owner, root):
    """Record the edit, then start a worker unless one is already running.

    The marker comes first. A worker that is running will see it before it
    lets go, or on its look after letting go; a worker that has already let
    go is not holding the lock, so this edit starts a new one. Two edits that
    both find the lock free both start one, and the second finds it held and
    exits, which costs a process and nothing else.
    """
    mark_pending(root)
    if not held(root):
        spawn([sys.executable, os.path.abspath(__file__), "--worker", root], owner)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    owner = home()
    if argv[:1] == ["--worker"]:
        # Spawned by `start`. The root is judged again rather than trusted, so
        # the worker entry point widens nothing.
        root = target_root(argv[1], owner) if len(argv) == 2 else None
        if root is not None:
            work(owner, root)
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
