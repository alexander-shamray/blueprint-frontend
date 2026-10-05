#!/usr/bin/env python3
"""Refresh the index of the checkout a change landed in, not the one the session started in.

**The refresh followed `CLAUDE_PROJECT_DIR`, and `/branch` moves the session
away from it (alexander-shamray/blueprint-frontend#48).** The `PostToolUse`
entry used to be `cd "${CLAUDE_PROJECT_DIR}" && run-index update`, which
anchored the wrapper safely and indexed the wrong tree: after `/branch` enters
a forked worktree, every edit refreshed the startup checkout, which the edit
never touched, and the worktree's own index went stale — the staleness #44 set
out to remove.

**Two halves, and only one of them moved.** The *wrapper* still comes from this
file's own checkout — the one `settings.json` names through
`CLAUDE_PROJECT_DIR`, where `.claude/skills/**` and `.claude/hooks/**` are
edit-denied — so no tree the session is standing in chooses the code that runs.
The *root* comes from the file the event edited, or from the event's `cwd`
when it names none, walked up to its checkout, and is handed to that trusted
wrapper as `--root`. `named` says why the file comes first.

**It runs after every Bash call as well as every edit
(alexander-shamray/blueprint-frontend#136).** Commits, pulls, rebases,
formatters and edit scripts change tracked files through the shell, and each
left the index answering from the old text, with its recorded commit behind
HEAD, while it reported itself fresh. A Bash event names no file, so its `cwd`
decides, and that follows the shell into a worktree. A call that wrote nothing
costs one `update` that changes nothing, detached and coalesced behind the
lock below.

**The root is taken only when it is this repository's own worktree, and never
a sweep's.** `git rev-parse --git-common-dir` there must resolve to this
checkout's common directory, so a change in an unrelated repository — or in no
repository — refreshes nothing. And a checkout whose directory starts
`secsweep-` is refused by name: `/security-sweep` and `/bug-sweep` detach their
worktrees under that prefix, `docs/harness-boundaries.md` calls the tree they
hold prompt-injection input, and indexing it would read that tree's
`.codeindexignore` and config with this checkout's tooling. It is the same
prefix `git-worktree-detach.sh` and `git-worktree-drop.sh` bind to.

**A checkout with no index is seeded, never built
(alexander-shamray/blueprint-frontend#127).** `seed` says how and why.

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

**And the worker compacts what it refreshed, because the package never does
(alexander-shamray/blueprint-frontend#128).** `codebase-index` runs no FTS
merge and no `VACUUM` on its index, so every `update` left segments and free
pages behind until the index outgrew its source many times over; the issue
owns the measurement. `compact` says when and how.
"""

import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.parse

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

# An index is compacted once its free pages pass this share of the file, or its
# full-text table passes this many segment rows per chunk — far above a fresh
# build's, which alexander-shamray/blueprint-frontend#128 measured.
FREE_SHARE = 0.5
ROWS_PER_CHUNK = 10

# A compaction that has not finished by now is interrupted, so an index whose
# schema a branch wrote cannot hold the worker, and the root's lock, for ever.
COMPACT_TIMEOUT = RUN_TIMEOUT

# The files SQLite opens by name beside a database.
SIDECARS = ("-wal", "-shm", "-journal")

# Every git call one event makes shares this many seconds, well inside the
# five `settings.json` gives the hook.
GIT_BUDGET = 3

_DEADLINE = None


def deadline():
    """The instant every git call in this process must finish by.

    One budget for the whole event, not one per caller: validation used a
    three-second deadline and then the state directory started another, which
    together could outlast the five seconds `settings.json` allows the hook,
    killing it before anything was scheduled. Raised by Copilot.
    """
    global _DEADLINE
    if _DEADLINE is None:
        _DEADLINE = time.monotonic() + GIT_BUDGET
    return _DEADLINE

# `git` must answer about the directory it is pointed at and nothing else.
GIT_ENV_OVERRIDES = ("GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE")


def home():
    """The checkout this hook belongs to: three directories above this file."""
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def same(a, b):
    """Whether `a` and `b` are one existing filesystem entry.

    By identity rather than by spelling. `normcase` folds case on Windows
    only, so on a case-insensitive macOS or Linux mount git could spell one
    path two ways and a real worktree failed every comparison here. Raised by
    Copilot. A path that cannot be examined is not the same as anything, so
    every check this feeds fails closed.
    """
    try:
        return os.path.samefile(a, b)
    except (OSError, ValueError):
        return False


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
    and a `.git` directory is only ever the repository's main checkout.

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
        # The repository's main checkout: its `.git` IS the common directory.
        # Compared with that rather than with the owner's checkout, because a
        # session started inside a linked worktree owns the hook from there,
        # and the main checkout is still this repository's. Raised by Copilot.
        # A link to it was refused above, so only the real directory matches.
        return same(marker, owner_common)
    if not os.path.isfile(marker):
        return False
    try:
        with open(marker, encoding="utf-8") as handle:
            text = handle.read().strip()
    except OSError:
        return False
    if not text.startswith("gitdir:"):
        return False
    # **One name, or it is somebody's second name for a real worktree's
    # marker.** A hard link is neither a link nor a junction, and it shares
    # the inode identity every comparison below rests on, so a forged
    # checkout could hard-link its `.git` to a registered one's and inherit
    # its backlink whole. Git never makes a second name for a `.git` file.
    # Raised by Copilot. The cost is that the link raises the count on BOTH
    # names, so the real worktree stops being refreshed while the forgery
    # exists: a denial of refresh by somebody who can already write beside
    # the repository, rather than a tree of theirs being indexed.
    try:
        if os.stat(marker).st_nlink > 1:
            return False
    except OSError:
        return False
    gitdir = os.path.join(toplevel, text.split(":", 1)[1].strip())
    admin = os.path.realpath(gitdir)
    if not same(os.path.dirname(admin), os.path.join(owner_common, "worktrees")):
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

    **Both the spelling git reported and what it resolves to**, because an
    event reaching a sweep's worktree through a symlink or junction is
    reported under the alias, whose name carries no prefix while the
    directory it opens does. Raised by Copilot.
    """
    for spelling in (toplevel, os.path.realpath(toplevel)):
        if os.path.basename(os.path.normpath(spelling)).casefold().startswith(
                SWEEP_PREFIX):
            return True
    return False


def named(event):
    """The directory an event's change landed in: the edited file's, else `cwd`.

    **The edited file decides, not the session's directory
    (alexander-shamray/blueprint-frontend#137).** #48 followed `cwd`, which
    covers a session that `/branch` moved into a worktree. A session that
    stays in the main checkout and edits `.claude/worktrees/<name>/…` by
    absolute path changed the worktree while its `cwd` names the main
    checkout, so the main checkout was refreshed and the worktree went stale.

    A relative path is relative to `cwd`, and it is resolved before anything
    walks it: `../../../src/app/x.ts` from a worktree under
    `.claude/worktrees/` lands in the main checkout, and the worktree is among
    that path's lexical parents. The nearest directory that exists at or above
    the file is the answer, so a file an edit removed still names its
    checkout. **An event that names a file is never answered with `cwd`**: a
    file that cannot be placed refreshes nothing rather than the tree it did
    not touch. An event naming no file — a Bash call, a session start —
    is answered with `cwd`. `target_root` judges either answer the same way.
    """
    cwd = event.get("cwd")
    given = event.get("tool_input")
    if not isinstance(given, dict):
        return cwd
    for key in ("file_path", "notebook_path"):
        value = given.get(key)
        if not isinstance(value, str) or not value.strip():
            continue
        path = value.strip()
        if not os.path.isabs(path):
            if not isinstance(cwd, str) or not cwd:
                return None
            path = os.path.join(cwd, path)
        try:
            directory = os.path.dirname(os.path.realpath(path))
        except (OSError, ValueError):
            return None
        while not os.path.isdir(directory):
            parent = os.path.dirname(directory)
            if parent == directory:
                return None
            directory = parent
        return directory
    return cwd


def target_root(cwd, owner):
    """The root to refresh for a change in directory `cwd`, or None to refresh nothing."""
    if not isinstance(cwd, str) or not cwd or not os.path.isdir(cwd):
        return None
    target = git_paths(cwd, deadline())
    mine = git_paths(owner, deadline())
    if target is None or mine is None:
        return None
    toplevel, common = target
    if not same(common, mine[1]):
        return None
    if not registered(toplevel, mine[0], mine[1]):
        return None
    if swept(toplevel):
        return None
    if not index_openable(toplevel):
        # **The indexer writes into the tree it indexes**, at
        # `<root>/.claude/cache/codebase-index`, and a branch can force-track
        # any component of that path as a link. The hook's own state moved
        # out of reach, but the wrapper's writes would still follow it, so a
        # target whose cache path is redirected is not refreshed at all.
        # Raised by Copilot. The index and the sidecars SQLite opens beside it
        # are on that path too, and the wrapper opens them before `compact`
        # could look (alexander-shamray/blueprint-frontend#128); `refresh`
        # asks again before every run, since this is asked once per worker. A
        # rollback journal beside the index refuses it too: `index_openable`.
        return None
    return os.path.normpath(toplevel)


def written(root):
    """Whether the root holds an index a build has written, not merely created.

    A file shorter than SQLite's 100-byte header is one a first build created
    and never wrote, which `update` cannot open: it is no index at all.
    """
    try:
        return os.path.getsize(os.path.join(root, CACHE, "index.sqlite")) >= 100
    except OSError:
        return False


def unlinked(path, base):
    """Whether every component of `path` below `base` is a real directory.

    Checked without following anything: `islink` and `isjunction` answer for
    the component itself, so a link anywhere under `base` is refused rather
    than walked through.
    """
    if os.path.islink(base) or os.path.isjunction(base):
        return False
    current = base
    for part in os.path.relpath(path, base).split(os.sep):
        if part in ("", "."):
            continue
        if part == "..":
            return False
        current = os.path.join(current, part)
        if os.path.islink(current) or os.path.isjunction(current):
            return False
    return True


def index_unlinked(root):
    """Whether the root's index, and each file SQLite opens beside it, is free of links.

    The whole cache path, the database and its `-wal`, `-shm` and `-journal`
    sidecars: SQLite opens each by name, so a link at any one of them aims a
    write wherever the branch that tracked it chose.
    """
    path = os.path.join(root, CACHE, "index.sqlite")
    if not unlinked(path, root):
        return False
    for suffix in SIDECARS:
        if os.path.islink(path + suffix) or os.path.isjunction(path + suffix):
            return False
    return True


def index_openable(root):
    """Whether the root's index may be opened at all, by the wrapper, `seed` or `compact`.

    No link on its path, no rollback journal beside it, and a header in WAL
    mode. The first connection to a rollback-mode database replays a
    `-journal` it finds beside it, and that replay acts on what the journal
    says, which a branch that force-tracks the file writes
    (alexander-shamray/blueprint-frontend#128). A WAL-mode index never makes
    a rollback journal, so one beside it, or a header that is not WAL,
    refuses the root. A `-wal` is admitted, and has to be: every open reader
    of the index keeps one, and WAL recovery writes only into the database,
    whose path was just checked. A root with no index yet is admitted,
    because the worker seeds one, and so is a file shorter than SQLite's
    100-byte header, which a first build creates before it writes anything:
    there is no database in it to replay into. The cost of a refusal is a
    stale index, never a write.
    """
    if not index_unlinked(root):
        return False
    path = os.path.join(root, CACHE, "index.sqlite")
    if os.path.lexists(path + "-journal"):
        return False
    try:
        with open(path, "rb") as handle:
            header = handle.read(100)
    except FileNotFoundError:
        return True
    except OSError:
        return False
    if len(header) < 100:
        return True
    # Bytes 18 and 19 are the file format's write and read versions; 2 is WAL.
    return header[18:20] == b"\x02\x02"


_MAIN_CHECKOUTS = {}


def main_checkout(owner):
    """The repository's main checkout, or None: the directory its common `.git` sits in.

    Asked of git once per process and remembered, as `state_dir` is, because
    the worker asks again long after the event's git budget is spent. A
    common directory not named `.git` — a bare repository, or a submodule's
    under `.git/modules/` — has no main checkout to seed from, and the answer
    is judged as any root is: registered, and not a sweep's.
    """
    if owner in _MAIN_CHECKOUTS:
        return _MAIN_CHECKOUTS[owner]
    paths = git_paths(owner, deadline())
    found = None
    if paths is not None:
        common = os.path.realpath(paths[1])
        if os.path.basename(common).casefold() == ".git":
            candidate = os.path.dirname(common)
            if registered(candidate, paths[0], paths[1]) and not swept(candidate):
                found = os.path.normpath(candidate)
    _MAIN_CHECKOUTS[owner] = found
    return found


def seed_source(owner, root):
    """The index a root with none is seeded from, or None.

    The main checkout's own and nothing else, and only past the judgement the
    root's own index gets: `index_openable`, and a written database. A main
    checkout with no index seeds nothing, itself included, and nothing is
    built in its place; one with an index is written, and asks for no seed.
    """
    if written(root):
        return None
    main = main_checkout(owner)
    if main is None:
        return None
    if not index_openable(main) or not written(main):
        return None
    source = os.path.join(main, CACHE, "index.sqlite")
    return source if os.path.isfile(source) else None


def refreshable(owner, root):
    """Whether a worker for `root` would have anything to do: an index, or one to seed."""
    return written(root) or seed_source(owner, root) is not None


def sqlite_uri(path, mode):
    """A `file:` URI for `path`, with an empty authority.

    Built by hand because `Path.as_uri()` puts a UNC server or a `?` of an
    extended-length path in the authority, and SQLite refuses both. Measured
    in blueprint-backend#513, round 5.
    """
    posix = path.replace(os.sep, "/")
    lead = "" if posix.startswith("/") else "/"
    return f"file://{lead}{urllib.parse.quote(posix)}?mode={mode}"


def seed(owner, root):
    """Give a root with no index its main checkout's; True when it now holds one.

    **A `/branch` worktree starts with no index
    (alexander-shamray/blueprint-frontend#127).** `.claude/cache/` is ignored,
    so every forked worktree begins empty, and this hook used to run a full
    `index` there. blueprint-backend measured that build at 230 s, against
    0.1 s to copy the main checkout's index and 5.1 s for the `update` after
    it, which re-reads only what the branch changed. So the hook never
    builds: a worktree is seeded from the main checkout and then updated, and
    a checkout with neither is left alone.

    **Through SQLite's backup, not a file copy**: the main checkout's own
    refresh may be writing, and a copied file can tear where a backup reads
    one consistent snapshot. Into a file beside the index named for this
    process; a backup of a WAL database carries its WAL header, and the copy
    is refused unless it does, since `index_openable` would refuse it next.
    Then renamed over the index path, so `update` never opens a partial
    file. A `-wal` or `-shm` left at that path is removed
    first, since a stale log would be replayed into the seed. Only
    `index.sqlite` crosses: the session memory, the config and the lock are
    the worktree's own.

    **The source is opened `mode=rw`**: `ro` cannot open a WAL database whose
    `-shm` is absent, and a plain connect would create an empty file at a
    path gone since `seed_source` looked. Called inside the worker's lock,
    after the root was judged. Every failure leaves no index and no partial
    file, so the next change tries again.
    """
    if written(root):
        return True
    source = seed_source(owner, root)
    if source is None or not index_openable(root):
        return False
    cache = os.path.join(root, CACHE)
    index = os.path.join(cache, "index.sqlite")
    partial = f"{index}.seed.{os.getpid()}"
    try:
        os.makedirs(cache, exist_ok=True)
        # Asked again now the directory exists: `makedirs` creates what was
        # missing, and only an unlinked path may receive the copy.
        if not index_openable(root):
            return False
        for suffix in ("",) + SIDECARS:
            if os.path.lexists(partial + suffix):
                return False
        reading = sqlite3.connect(sqlite_uri(source, "rw"), uri=True, timeout=30)
        try:
            writing = sqlite3.connect(partial, timeout=30)
            try:
                reading.backup(writing)
            finally:
                writing.close()
        finally:
            reading.close()
        with open(partial, "rb") as handle:
            if handle.read(100)[18:20] != b"\x02\x02":
                return False
        for suffix in ("-wal", "-shm"):
            try:
                os.remove(index + suffix)
            except FileNotFoundError:
                pass
        os.replace(partial, index)
    except (OSError, sqlite3.Error):
        return False
    finally:
        for suffix in ("",) + SIDECARS:
            try:
                os.remove(partial + suffix)
            except OSError:
                pass
    return written(root) and index_openable(root)


_STATE_DIRS = {}


def state_dir(owner):
    """Where this hook keeps its own state: never in a tree a branch controls.

    **The tree being indexed must not choose where a trusted write lands.**
    The lock and the marker first sat under the target's own
    `.claude/cache/`, and a branch can commit a symlink there — `makedirs`
    and `open` follow it, and `Lock.write` truncates what it finds. Moving
    them to the owner's cache was not enough: the owner is a checkout too,
    `.claude/cache` is edit-denied nowhere, and the owner can even BE the
    target. Raised by Copilot twice.

    So the state lives in the repository's git directory — `<common>/
    index-refresh/` — which no branch can write, because git tracks nothing
    there. A checkout whose git directory cannot be found, or whose path
    into it passes through a link, gets no refresh at all rather than one
    through somebody's redirection.
    """
    if owner in _STATE_DIRS:
        return _STATE_DIRS[owner]
    paths = git_paths(owner, deadline())
    resolved = None
    if paths is not None:
        candidate = os.path.join(paths[1], "index-refresh")
        if unlinked(candidate, paths[1]):
            resolved = candidate
    _STATE_DIRS[owner] = resolved
    return resolved


def identity(path):
    """A name for the entry `path` opens, stable across its spellings.

    The filesystem's own answer — device and inode — because `normcase`
    folds case on Windows only, so on a case-insensitive macOS or Linux
    volume two spellings of one worktree hashed to two different locks, and
    two indexers could run against one cache. Raised by Copilot. Where the
    entry cannot be examined, the resolved spelling is all there is.
    """
    try:
        info = os.stat(path)
        return f"{info.st_dev}:{info.st_ino}"
    except OSError:
        return os.path.normcase(os.path.realpath(path))


def state_path(owner, root, suffix):
    directory = state_dir(owner)
    if directory is None:
        return None
    key = hashlib.sha256(identity(root).encode("utf-8", "replace")).hexdigest()
    return os.path.join(directory, f"{key[:32]}.{suffix}")


def lock_path(owner, root):
    return state_path(owner, root, "lock")


def pending_path(owner, root):
    return state_path(owner, root, "pending")


class Lock:
    """The root's refresh lock: an OS advisory lock on an open handle.

    Held from `acquire` until `release` or the process's exit, whichever is
    first, and by one process at a time. Windows locks a byte range per
    handle, POSIX `flock` locks per open file, and in both a second handle in
    the same process is refused like any other, which is what lets the suite
    hold it from a test.
    """

    def __init__(self, owner, root):
        self.path = lock_path(owner, root)
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

    def read(self):
        """What the holder last wrote in the lock file."""
        if self.handle is None:
            with open(self.path, "rb") as handle:
                return handle.read().decode("ascii", "replace")
        self.handle.seek(0)
        return self.handle.read().decode("ascii", "replace")

    def write(self, text):
        """Record something in the lock file; only the holder may.

        Written through the held handle, so the record and the lock live and
        die together: a worker that never took the lock cannot leave one.
        """
        if self.handle is None:
            return
        try:
            self.handle.seek(0)
            self.handle.truncate()
            self.handle.write(text.encode("ascii"))
            self.handle.flush()
        except OSError:
            pass

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


def held(owner, root):
    """Whether a worker holds the root's lock right now."""
    probe = Lock(owner, root)
    if not probe.acquire():
        return True
    probe.release()
    return False


def take_pending(owner, root):
    """Consume the root's pending marker; True when there was one.

    **Removing a marker an edit is still creating loses nothing, because the
    marker never carries the edit.** The hook runs after the edit is on disk,
    and the worker removes a marker only as the first step of a refresh. So
    whoever unlinks it — even out from under an edit whose `open` has not yet
    closed — goes on to refresh a tree that already holds that edit. On
    Windows the unlink of an open file fails instead, and the marker survives
    for the next look. Raised by Copilot as a lost edit; it is a lost marker,
    which the refresh after it makes redundant.

    **A removal that fails is not an absent marker**, and reporting it as one
    spun the worker: the inner loop ended, the marker was still there, and the
    outer loop took the lock again and retried with nothing changed, for ever.
    Raised by Copilot. `None` says the marker is there and could not be taken,
    which ends the worker and leaves the marker for the next edit to serve.
    """
    try:
        os.remove(pending_path(owner, root))
        return True
    except FileNotFoundError:
        return False
    except OSError:
        return None


def mark_pending(owner, root):
    os.makedirs(os.path.dirname(pending_path(owner, root)), exist_ok=True)
    with open(pending_path(owner, root), "a", encoding="ascii"):
        pass


def alive(pid):
    """Whether a process with this id is running."""
    if pid <= 0:
        return False
    if os.name == "nt":
        out = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}", "/NH"],
            capture_output=True, text=True, timeout=10, check=False)
        return str(pid) in out.stdout
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def running_indexer(lock):
    """The pid the lock records, when that indexer is still running.

    **A worker's lock says nothing about the indexer it started.** The lock
    is the worker's, and a worker killed mid-run leaves `run-index` behind:
    the kernel frees the lock, the next edit starts a second worker, and two
    indexers write one SQLite cache. Raised by Copilot. So the worker records
    its child's pid in the lock file, and a worker that takes the lock and
    finds that child still running leaves the tree to it.

    **The worker records its OWN pid first**, from the moment before the
    child is started until the child's pid is known, because a worker killed
    between the two would otherwise leave an indexer nobody could name.
    Raised by Copilot. The window this cannot close is the instant between
    the child existing and its pid being written — `Popen` returns a
    started process, so the record is written next, but a kill landing
    exactly there leaves an orphan with the dead worker's pid beside it.
    Both records read the same way: a live pid means stand off.
    """
    try:
        recorded = lock.read().strip()
    except OSError:
        return None
    if not recorded.isdigit():
        return None
    pid = int(recorded)
    try:
        return pid if alive(pid) else None
    except (OSError, subprocess.SubprocessError):
        # Unknown is treated as running: one skipped refresh, never two
        # indexers. The next edit asks again.
        return pid


def refresh(owner, root, lock):
    """Seed the root if it has no index, then run the owner's wrapper's `update` once."""
    bash = shutil.which("bash")
    if bash is None or not index_openable(root):
        # Judged on every run and not once per worker: a worker refreshes for
        # as long as edits keep coming, and a checkout in between can put a
        # link, or a journal, where the wrapper is about to open the index.
        return
    if not seed(owner, root):
        # No index and none to seed from: nothing is built in its place.
        return
    child = None
    # Claimed before the child exists, so a worker killed while starting one
    # is still a live pid to the next worker rather than a silent orphan.
    lock.write(str(os.getpid()))
    try:
        child = subprocess.Popen(
            [bash, os.path.join(owner, WRAPPER), "--quiet", "--root", root, "update"],
            cwd=owner, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL)
        lock.write(str(child.pid))
        if child.wait(timeout=RUN_TIMEOUT) == 0:
            compact(root)
    except (OSError, subprocess.SubprocessError):
        if child is not None:
            child.kill()
    finally:
        # Reaped before the record is cleared: `kill` only asks, and a
        # coalesced refresh must not start beside a process still exiting.
        # Raised by Copilot.
        if child is not None:
            try:
                child.wait(timeout=RUN_TIMEOUT)
            except (OSError, subprocess.SubprocessError):
                pass
        lock.write("")


def shaped(conn):
    """Whether the tables `compact` counts and merges are the package's.

    Judged from the parsed schema, never from its text: `PRAGMA table_list`
    reports what SQLite built. Names are folded as SQLite folds them, ASCII
    only, and a file with any table name outside ASCII is refused: Python's
    `lower()` would fold a KELVIN SIGN onto `k` where SQLite does not, and
    two objects would meet on one key. The package's names are all ASCII.
    Every `fts_chunks_` table must be a shadow table, so a plain table or a
    view among them is refused. SQLite marks a shadow from its name alone,
    asking the module of `fts_chunks` whether the suffix is one of its own,
    so this pins which module is present — only FTS5 claims `data` — and
    which kinds of object, not how the tables are declared or what they
    hold; `chunks` must be a plain table.
    Triggers are not judged here: `compact` switches them off on its own
    connection, which no spelling of a name and no edit to `sqlite_master`
    gets round. A file lacking `chunks` is refused here, and one lacking
    `fts_chunks_data` fails in `bloated`; either is left alone. Reading the
    schema runs none of it. A SQLite without `table_list`, before 3.37,
    reports nothing, and nothing is compacted.
    """
    rows = conn.execute("PRAGMA main.table_list").fetchall()
    if not all(row[1].isascii() for row in rows):
        return False
    kinds = {row[1].lower(): row[2] for row in rows}
    if kinds.get("chunks") != "table":
        return False
    return all(kind == "shadow" for name, kind in kinds.items()
               if name.startswith("fts_chunks_"))


def bloated(conn):
    """Whether the index behind `conn` has outgrown its data by either measure."""
    pages = conn.execute("PRAGMA page_count").fetchone()[0]
    free = conn.execute("PRAGMA freelist_count").fetchone()[0]
    rows = conn.execute("SELECT count(*) FROM fts_chunks_data").fetchone()[0]
    chunks = conn.execute("SELECT count(*) FROM chunks").fetchone()[0]
    return free > pages * FREE_SHARE or rows > ROWS_PER_CHUNK * max(chunks, 1)


def compact(root):
    """Merge the root's full-text index and reclaim its free pages, when needed.

    **`codebase-index` never compacts the file it writes
    (alexander-shamray/blueprint-frontend#128).** Each `update` deletes a
    changed file's chunks and inserts new ones; FTS5 records the deletes as
    new segments, SQLite puts the freed pages on its freelist, and with
    `auto_vacuum` off the file only grows. FTS `optimize` merges the
    segments into one and `VACUUM` gives the pages back; the issue owns what
    that did to a copy of this checkout's index.

    **Only past a threshold, because both rewrite the whole file**: free
    pages past `FREE_SHARE` of it, or more than `ROWS_PER_CHUNK` segment
    rows per chunk. A lean index is read and left as it was.

    **Called only after `run-index` exited 0, and inside the worker's
    lock**, so no refresh of this hook's writes the file while it is
    rewritten, and a failed `update` — which may be a package that cannot
    read this index at all — is not followed by a rewrite of it.

    **Judged again just before the open, and against whatever schema the
    file carries.** A branch can force-track a crafted `index.sqlite`, so
    `index_openable` runs again here, because the rewrite is this hook's own
    and may run long after `target_root` judged the root: a worker judges it
    once, then refreshes and compacts for as long as edits keep coming. A
    link placed between that check and SQLite's opens is the residual
    `docs/harness-boundaries.md` records. The schema is the file's too: a
    file whose tables are not the package's shape is left alone, which
    refuses a view at every name compaction reads; triggers are switched off
    on this connection, so none the file carries runs, whatever its names'
    case; schema functions are not trusted; and a SQLite that cannot do all
    of these compacts nothing. `COMPACT_TIMEOUT` interrupts whatever does
    not finish.

    **Every SQLite error leaves a valid index, never a broken one.** Each
    statement commits alone — `VACUUM` cannot share a transaction — so an
    error after `optimize` leaves the segments merged and the pages not yet
    reclaimed. The worst cost is a large index, which is the cost before
    this existed.
    """
    path = os.path.join(root, CACHE, "index.sqlite")
    if not index_openable(root) or not os.path.isfile(path):
        return False
    try:
        conn = sqlite3.connect(path, timeout=30, isolation_level=None)
    except sqlite3.Error:
        return False
    deadline = time.monotonic() + COMPACT_TIMEOUT
    conn.set_progress_handler(lambda: time.monotonic() > deadline, 10000)
    try:
        conn.execute("PRAGMA trusted_schema=OFF")
        # A SQLite older than 3.31 ignores the pragma without an error.
        if conn.execute("PRAGMA trusted_schema").fetchone() != (0,):
            return False
        # Off on this connection, whatever the file's schema calls them, and
        # read back: `setconfig` returns nothing, and a set that fails raises.
        if not hasattr(conn, "setconfig"):
            return False
        conn.setconfig(sqlite3.SQLITE_DBCONFIG_ENABLE_TRIGGER, False)
        if conn.getconfig(sqlite3.SQLITE_DBCONFIG_ENABLE_TRIGGER):
            return False
        if not shaped(conn) or not bloated(conn):
            return False
        conn.execute("INSERT INTO fts_chunks(fts_chunks) VALUES('optimize')")
        conn.execute("VACUUM")
        # The index is in WAL mode, so the file shrinks at the checkpoint;
        # a reader holding a snapshot makes it report busy instead of raising,
        # and the rewrite waits in the `-wal` for a later one.
        busy = conn.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()[0]
        return busy == 0
    except sqlite3.Error:
        return False
    finally:
        conn.close()


def work(owner, root):
    """The worker: refresh while an edit is waiting, then let go.

    A second worker for the same root finds the lock held and returns at
    once. After letting go the worker looks for a marker once more: an edit
    that marked while it still held the lock saw it held and started nothing,
    so this look is what serves it. A root with no index finds its main
    checkout before the first refresh, inside the git budget the worker
    started with, because `seed` asks for it after that budget is spent; a
    root with one never needs it.
    """
    if state_dir(owner) is None:
        return
    if not written(root):
        main_checkout(owner)
    lock = Lock(owner, root)
    while lock.acquire():
        try:
            if running_indexer(lock) is not None:
                return
            while True:
                taken = take_pending(owner, root)
                if taken is None:
                    # A marker that would not go: stop, rather than take the
                    # lock again and meet it unchanged for ever.
                    return
                if not taken:
                    break
                refresh(owner, root, lock)
        finally:
            lock.release()
        if not os.path.exists(pending_path(owner, root)):
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
    if state_dir(owner) is None:
        return
    mark_pending(owner, root)
    if not held(owner, root):
        spawn([sys.executable, os.path.abspath(__file__), "--worker", root], owner)


def read_event(stream):
    """The event on `stream`, decoded as UTF-8 from its bytes where it has them.

    Python reads a Windows pipe in the ANSI code page, which turns a
    non-ASCII path in the event into one that does not exist. Measured in
    blueprint-backend#513, round 1. None when it is not a JSON object.
    """
    raw = getattr(stream, "buffer", None)
    try:
        if raw is not None:
            event = json.loads(raw.read().decode("utf-8", "replace") or "null")
        else:
            event = json.load(stream)
    except (ValueError, UnicodeDecodeError, OSError):
        return None
    return event if isinstance(event, dict) else None


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
    event = read_event(sys.stdin)
    if event is None:
        return 0
    root = target_root(named(event), owner)
    if root is None or shutil.which("bash") is None:
        return 0
    try:
        # A checkout with no index and nothing to seed it from gets no worker:
        # most Bash calls land here when nothing is indexed, and each would
        # otherwise start a process that finds nothing to do.
        if refreshable(owner, root):
            start(owner, root)
    except OSError:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
