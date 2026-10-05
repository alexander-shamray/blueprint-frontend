"""What `.claude/hooks/index-refresh.py` refreshes, and what it must refuse.

**The subject is the root the refresh is handed**, because that is the whole of
what #48 changed: the wrapper was always this checkout's, and the tree it
indexed was always `CLAUDE_PROJECT_DIR`'s. Each case builds a real repository
with real linked worktrees, because the decision is a comparison of what `git`
says about two directories and a stand-in for `git` would test the stand-in.

The last class has the registration as its subject — the gate-coverage lesson
in `CLAUDE.md`: every case above judges the module, which says nothing about
whether `settings.json` still calls it.
"""

import importlib.util
import io
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock


SCRIPTS = Path(__file__).resolve().parent
HOOK = SCRIPTS.parent / "hooks" / "index-refresh.py"
SETTINGS = SCRIPTS.parent / "settings.json"


def load():
    spec = importlib.util.spec_from_file_location("index_refresh", HOOK)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def git(*args, cwd):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


def real(path):
    return os.path.normcase(os.path.realpath(path))


def index_path(root):
    return os.path.join(root, ".claude", "cache", "codebase-index", "index.sqlite")


def write_index(root, text="main"):
    """A small WAL-mode index at the root's cache path, as the package leaves one."""
    path = index_path(root)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    conn = sqlite3.connect(path, isolation_level=None)
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("CREATE TABLE chunks (id INTEGER PRIMARY KEY, content TEXT)")
        conn.execute("INSERT INTO chunks (content) VALUES (?)", (text,))
    finally:
        conn.close()
    return path


def read_index(path):
    conn = sqlite3.connect(path)
    try:
        return [row[0] for row in conn.execute("SELECT content FROM chunks")]
    finally:
        conn.close()


class TheRootFollowsTheActiveWorktree(unittest.TestCase):

    def setUp(self):
        self.hook = load()
        self.base = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.base, ignore_errors=True)
        self.main = os.path.join(self.base, "repo")
        os.mkdir(self.main)
        git("init", "-q", cwd=self.main)
        git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q",
            "--allow-empty", "-m", "root", cwd=self.main)
        self.sibling = os.path.join(self.base, "repo-feature")
        git("worktree", "add", "-q", "-b", "feature", self.sibling, cwd=self.main)
        self.sweep = os.path.join(self.base, "secsweep-abc123")
        git("worktree", "add", "-q", "--detach", self.sweep, cwd=self.main)
        self.common = os.path.join(self.main, ".git")

    def test_an_edit_in_a_sibling_worktree_refreshes_that_worktree(self):
        root = self.hook.target_root(self.sibling, self.main)
        self.assertIsNotNone(root)
        self.assertEqual(real(self.sibling), real(root))

    def test_an_edit_in_a_nested_worktree_refreshes_that_worktree(self):
        # /branch forks under the main checkout's .claude/worktrees/, so the
        # worktree also sits inside the main checkout's tree; the innermost
        # checkout is the one the edit changed.
        nested = os.path.join(self.main, ".claude", "worktrees", "nested")
        git("worktree", "add", "-q", "-b", "nested", nested, cwd=self.main)
        sub = os.path.join(nested, "src")
        os.makedirs(sub)
        self.assertEqual(real(nested), real(self.hook.target_root(sub, self.main)))

    def test_a_subdirectory_is_walked_up_to_its_checkout(self):
        sub = os.path.join(self.sibling, "src", "app")
        os.makedirs(sub)
        self.assertEqual(real(self.sibling), real(self.hook.target_root(sub, self.main)))

    def test_the_startup_checkout_still_refreshes_itself(self):
        self.assertEqual(real(self.main), real(self.hook.target_root(self.main, self.main)))

    def test_a_sweep_checkout_is_refused(self):
        self.assertIsNone(self.hook.target_root(self.sweep, self.main))

    def test_paths_are_compared_by_identity_not_spelling(self):
        # Copilot, round 7: `normcase` folds case on Windows only, so on a
        # case-insensitive macOS or Linux mount one path spelled two ways
        # failed the comparisons. Whether the filesystem folds case is its own
        # answer, so the expectation is read from it rather than assumed: the
        # case variant must be the same entry exactly when it exists at all.
        common = os.path.realpath(self.common)
        variant = os.path.join(os.path.dirname(common), ".GIT")
        folds = os.path.exists(variant)
        self.assertEqual(folds, self.hook.same(common, variant))
        # And through the state key, which hashed a spelling: two spellings
        # of one worktree chose two locks, and two indexers could run.
        # Copilot, round 11.
        spelled = os.path.join(os.path.dirname(self.sibling),
                               os.path.basename(self.sibling).upper())
        if os.path.exists(spelled):
            self.assertEqual(self.hook.lock_path(self.main, self.sibling),
                             self.hook.lock_path(self.main, spelled))
        self.assertEqual(self.hook.identity(self.sibling),
                         self.hook.identity(self.sibling + os.sep))
        self.assertNotEqual(self.hook.identity(self.sibling),
                            self.hook.identity(self.main))
        # And through the admin-directory containment, which compared strings.
        self.assertEqual(folds, self.hook.registered(self.sibling, self.main, variant))
        self.assertTrue(self.hook.registered(self.sibling, self.main, common))
        # A path that does not exist is the same as nothing.
        self.assertFalse(self.hook.same(os.path.join(self.base, "absent"), common))

    def test_a_session_started_in_a_worktree_still_refreshes_the_main_checkout(self):
        # Copilot, round 6: with the hook owned by a linked worktree, the main
        # checkout's `.git` directory was compared with the owner's checkout
        # and refused, so its edits refreshed nothing.
        root = self.hook.target_root(self.main, self.sibling)
        self.assertIsNotNone(root)
        self.assertEqual(real(self.main), real(root))
        # And from there, the other linked worktree too.
        self.assertEqual(real(self.sibling), real(self.hook.target_root(self.sibling, self.sibling)))

    def link(self, source, target):
        """A directory link, by whichever primitive this platform grants."""
        try:
            os.symlink(target, source, target_is_directory=True)
        except (OSError, NotImplementedError):
            if os.name != "nt":
                raise
            subprocess.run(["cmd", "/c", "mklink", "/J", source, target],
                           check=True, capture_output=True)

    def test_the_hooks_state_lives_where_no_branch_can_redirect_it(self):
        # Copilot, rounds 9 and 10: the lock and marker sat first under the
        # target's `.claude/cache/` and then under the owner's, and a branch
        # can force-track a symlink at either — `makedirs` follows it and the
        # lock's write truncates what it finds. They now live in the git
        # directory, which holds no tracked file at all.
        aimed = os.path.join(self.base, "aimed-at")
        os.mkdir(aimed)
        for owner in (self.main, self.sibling):
            with self.subTest(owner=owner):
                self.hook._STATE_DIRS.clear()
                cache = os.path.join(owner, ".claude", "cache")
                if not os.path.isdir(os.path.dirname(cache)):
                    os.makedirs(os.path.dirname(cache))
                    self.link(cache, aimed)
                path = self.hook.lock_path(owner, self.sibling)
                self.assertIsNotNone(path)
                self.assertFalse(real(path).startswith(real(aimed)))
                self.assertIn("index-refresh", path)

        self.hook._STATE_DIRS.clear()
        self.hook.mark_pending(self.main, self.sibling)
        lock = self.hook.Lock(self.main, self.sibling)
        self.assertTrue(lock.acquire())
        lock.write("12345")
        lock.release()
        self.assertEqual([], os.listdir(aimed), "a write landed where the tree aimed it")
        # Two roots keep two locks: the name is derived from the target.
        self.assertNotEqual(self.hook.lock_path(self.main, self.sibling),
                            self.hook.lock_path(self.main, self.main))

    def test_a_linked_path_into_the_state_directory_refreshes_nothing(self):
        # And if the git directory itself cannot be reached without passing
        # through a link, there is no safe place to keep the state, so the
        # refresh does not happen rather than happening through it.
        self.hook._STATE_DIRS.clear()
        with mock.patch.object(self.hook, "unlinked", return_value=False):
            self.assertIsNone(self.hook.state_dir(self.main))
            self.assertIsNone(self.hook.lock_path(self.main, self.sibling))
            with mock.patch.object(self.hook, "spawn") as spawn:
                self.hook.start(self.main, self.sibling)
            spawn.assert_not_called()
        self.hook._STATE_DIRS.clear()

    def test_a_target_whose_cache_path_is_redirected_is_refused(self):
        # Copilot, round 10: the indexer writes into the tree it indexes, so
        # a branch that force-tracks `.claude/cache` as a link has the
        # trusted wrapper write through it. Moving the hook's own state did
        # not cover that; refusing the target does.
        aimed = os.path.join(self.base, "aimed-at-cache")
        os.mkdir(aimed)
        cache = os.path.join(self.sibling, ".claude", "cache")
        os.makedirs(os.path.dirname(cache))
        self.link(cache, aimed)
        self.assertIsNone(self.hook.target_root(self.sibling, self.main))
        # The unredirected worktree beside it is still refreshed.
        self.assertIsNotNone(self.hook.target_root(self.main, self.main))

    def test_a_target_with_a_rollback_journal_is_refused(self):
        # A WAL-mode index at rest leaves no journal, and the first connection
        # to a rollback-mode one replays whatever journal it finds, so an
        # ordinary file at that name refuses the root as a link would.
        cache = os.path.join(self.sibling, ".claude", "cache", "codebase-index")
        os.makedirs(cache)
        journal = os.path.join(cache, "index.sqlite-journal")
        Path(journal).write_bytes(b"")
        self.hook._DEADLINE = None
        self.assertIsNone(self.hook.target_root(self.sibling, self.main))
        os.remove(journal)
        self.hook._DEADLINE = None
        self.assertIsNotNone(self.hook.target_root(self.sibling, self.main))

    def test_a_target_whose_index_or_sidecar_is_a_link_is_refused(self):
        # The wrapper opens the index, and SQLite its sidecars by name, before
        # `compact` could look, so a link at any of them refuses the root and
        # not only the compaction (alexander-shamray/blueprint-frontend#128).
        # Each call gets a fresh git budget, so a refusal here is the link's
        # and never a spent deadline's.
        # A real WAL-mode database, so for `index.sqlite` only the link check
        # can refuse it and never the header check.
        aimed = os.path.join(self.base, "aimed-at-file")
        conn = sqlite3.connect(aimed)
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("CREATE TABLE kept (x)")
        finally:
            conn.close()
        kept = Path(aimed).read_bytes()
        cache = os.path.join(self.sibling, ".claude", "cache", "codebase-index")
        os.makedirs(cache)
        for name in ("index.sqlite", "index.sqlite-wal", "index.sqlite-shm",
                     "index.sqlite-journal"):
            with self.subTest(name=name):
                try:
                    os.symlink(aimed, os.path.join(cache, name))
                except (OSError, NotImplementedError):
                    self.skipTest("this platform grants no file symlink here")
                try:
                    self.hook._DEADLINE = None
                    self.assertIsNone(self.hook.target_root(self.sibling, self.main))
                finally:
                    os.remove(os.path.join(cache, name))
        self.assertEqual(kept, Path(aimed).read_bytes())
        # With no link left, the same worktree is refreshed.
        self.hook._DEADLINE = None
        self.assertIsNotNone(self.hook.target_root(self.sibling, self.main))

    def test_a_sweep_worktree_reached_through_an_alias_is_refused(self):
        # Copilot, round 10: through a link, git reports the alias, whose
        # name carries no reserved prefix while the directory it opens does.
        alias = os.path.join(self.base, "ordinary-name")
        self.link(alias, self.sweep)
        self.assertTrue(self.hook.swept(alias))
        self.assertIsNone(self.hook.target_root(alias, self.main))

    def test_a_sweep_checkout_is_refused_in_any_case(self):
        # Copilot, round 4: on a case-folding filesystem `SECSWEEP-x` is the
        # same name as `secsweep-x`, and a case-sensitive prefix let it by.
        upper = os.path.join(self.base, "SECSWEEP-XYZ789")
        git("worktree", "add", "-q", "--detach", upper, cwd=self.main)
        self.assertIsNone(self.hook.target_root(upper, self.main))
        self.assertTrue(self.hook.swept(os.path.join(self.base, "SecSweep-abc")))
        self.assertFalse(self.hook.swept(self.sibling))

    def test_one_event_spends_one_git_budget(self):
        # Copilot, round 11: validation took a three-second budget and the
        # state directory then started another, which together could outlast
        # the five seconds the hook is given and be killed before anything
        # was scheduled. Every git call in the process shares one deadline.
        self.hook._DEADLINE = None
        self.hook._STATE_DIRS.clear()
        # Seedable, so the event goes on to the state directory and every
        # git call the hook makes is on the path.
        write_index(self.main)
        deadlines = []
        real_git_paths = self.hook.git_paths

        def recording(directory, when):
            deadlines.append(when)
            return real_git_paths(directory, when)

        event = json.dumps({"cwd": self.sibling, "hook_event_name": "PostToolUse"})
        with mock.patch.object(self.hook, "home", return_value=self.main), \
                mock.patch.object(self.hook, "git_paths", side_effect=recording), \
                mock.patch.object(self.hook, "spawn"), \
                mock.patch("sys.stdin", io.StringIO(event)):
            self.assertEqual(0, self.hook.main([]))
        self.assertGreater(len(deadlines), 2, "validation and the state dir both ask")
        self.assertEqual({deadlines[0]}, set(deadlines))
        self.assertLess(self.hook.GIT_BUDGET, 5)
        self.hook._DEADLINE = None
        self.hook._STATE_DIRS.clear()

    def test_the_git_calls_share_one_deadline(self):
        # Copilot, round 4: two calls each allowed three seconds could outlast
        # the hook's five, which would be killed before it spawned anything.
        # A deadline already spent refuses before running git at all.
        with mock.patch.object(self.hook.subprocess, "run") as run:
            self.assertIsNone(
                self.hook.git_paths(self.sibling, self.hook.time.monotonic() - 1))
        run.assert_not_called()
        self.assertLess(self.hook.GIT_BUDGET, 5)
        settings = json.loads(SETTINGS.read_text(encoding="utf-8"))
        timeouts = [
            h.get("timeout") for entry in settings["hooks"]["PostToolUse"]
            for h in entry.get("hooks", []) if "index-refresh.py" in h.get("command", "")]
        self.assertTrue(timeouts)
        for timeout in timeouts:
            self.assertLess(self.hook.GIT_BUDGET, timeout)

    def test_another_repository_is_refused(self):
        other = os.path.join(self.base, "other")
        os.mkdir(other)
        git("init", "-q", cwd=other)
        self.assertIsNone(self.hook.target_root(other, self.main))

    def test_a_directory_outside_any_repository_is_refused(self):
        loose = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, loose, ignore_errors=True)
        self.assertIsNone(self.hook.target_root(loose, self.main))

    def test_a_missing_or_malformed_cwd_is_refused(self):
        for cwd in (None, "", 7, os.path.join(self.base, "absent")):
            with self.subTest(cwd=cwd):
                self.assertIsNone(self.hook.target_root(cwd, self.main))

    def test_the_event_starts_a_worker_for_the_active_worktree(self):
        # The #48 case end to end: `cwd` differs from the checkout that owns
        # the hook, and the worker is started for the worktree, from the
        # owner. The spawn is replaced, not the decision. The main checkout
        # has an index, so the worktree is seedable and worth a worker
        # (blueprint-frontend#127).
        write_index(self.main)
        event = json.dumps({"cwd": self.sibling, "hook_event_name": "PostToolUse"})
        with mock.patch.object(self.hook, "home", return_value=self.main), \
                mock.patch.object(self.hook, "spawn") as spawn, \
                mock.patch("sys.stdin", io.StringIO(event)):
            self.assertEqual(0, self.hook.main([]))
        spawn.assert_called_once()
        argv, cwd = spawn.call_args.args
        self.assertEqual(real(self.main), real(cwd))
        self.assertEqual("--worker", argv[2])
        self.assertEqual(real(self.sibling), real(argv[3]))
        self.assertEqual(4, len(argv))
        self.assertTrue(os.path.isfile(self.hook.pending_path(self.main, argv[3])))

    def test_the_refresh_runs_the_owners_wrapper_against_the_worktree(self):
        write_index(self.main)
        # Found before `Popen` is replaced, as the worker finds it before its
        # first refresh: `git` itself is started through `Popen`.
        self.hook.main_checkout(self.main)
        lock = mock.Mock()
        with mock.patch.object(self.hook.subprocess, "Popen") as popen:
            popen.return_value.pid = 4242
            self.hook.refresh(self.main, self.sibling, lock)
        argv = popen.call_args.args[0]
        self.assertEqual(real(self.main), real(popen.call_args.kwargs["cwd"]))
        # The child's pid goes in the lock while it runs and out afterwards,
        # so a later worker can tell an orphaned indexer from a finished one.
        self.assertEqual(
            [mock.call(str(os.getpid())), mock.call("4242"), mock.call("")],
            lock.write.call_args_list)
        self.assertEqual(
            real(os.path.join(self.main, ".claude", "skills", "codebase-index",
                              "scripts", "run-index")),
            real(argv[1]))
        self.assertEqual(["--quiet", "--root", self.sibling], argv[2:5])
        # The new worktree had no index: it was seeded from the main
        # checkout's and is updated, never built (blueprint-frontend#127).
        self.assertEqual(["update"], argv[5:])
        self.assertEqual(["main"], read_index(index_path(self.sibling)))

    def test_only_a_written_index_counts_as_one(self):
        # A first build creates the file before it writes SQLite's header,
        # and `update` cannot open what that leaves.
        self.assertFalse(self.hook.written(self.sibling))
        cache = os.path.dirname(index_path(self.sibling))
        os.makedirs(cache)
        Path(cache, "index.sqlite").write_bytes(b"")
        self.assertFalse(self.hook.written(self.sibling))
        Path(cache, "index.sqlite").write_bytes(b"\0" * 100)
        self.assertTrue(self.hook.written(self.sibling))

    def test_a_worktree_is_seeded_from_the_main_checkout_and_never_built(self):
        # blueprint-frontend#127: the seed is a copy of the main checkout's index, in WAL mode
        # so the hook's own judgement admits it, renamed in whole, and the
        # main checkout's index is read and not changed.
        source = write_index(self.main)
        before = read_index(source)
        self.assertTrue(self.hook.refreshable(self.main, self.sibling))
        self.assertTrue(self.hook.seed(self.main, self.sibling))
        seeded = index_path(self.sibling)
        self.assertEqual(["main"], read_index(seeded))
        with open(seeded, "rb") as handle:
            self.assertEqual(b"\x02\x02", handle.read(100)[18:20])
        self.assertTrue(self.hook.index_openable(self.sibling))
        self.assertEqual(before, read_index(source))
        self.assertEqual(["index.sqlite"], sorted(
            name for name in os.listdir(os.path.dirname(seeded))
            if not name.startswith("index.sqlite-")))

    def test_nothing_is_seeded_or_built_without_a_main_index(self):
        # The acceptance's other half: no index on main means no index
        # anywhere, and no wrapper run that would build one.
        self.assertFalse(self.hook.refreshable(self.main, self.sibling))
        self.assertFalse(self.hook.seed(self.main, self.sibling))
        self.assertFalse(os.path.exists(index_path(self.sibling)))
        with mock.patch.object(self.hook.subprocess, "Popen") as popen:
            self.hook.refresh(self.main, self.sibling, mock.Mock())
        popen.assert_not_called()
        event = json.dumps({"cwd": self.sibling, "hook_event_name": "PostToolUse"})
        with mock.patch.object(self.hook, "home", return_value=self.main), \
                mock.patch.object(self.hook, "spawn") as spawn, \
                mock.patch("sys.stdin", io.StringIO(event)):
            self.assertEqual(0, self.hook.main([]))
        spawn.assert_not_called()

    def test_the_main_checkout_is_never_seeded(self):
        # Its index is the seed; one missing there is the user's to build.
        write_index(self.sibling)
        for owner in (self.main, self.sibling):
            with self.subTest(owner=owner):
                self.assertIsNone(self.hook.seed_source(owner, self.main))
                self.assertFalse(self.hook.seed(owner, self.main))

    def test_an_index_already_there_is_left_alone(self):
        write_index(self.main)
        write_index(self.sibling, "branch")
        self.assertIsNone(self.hook.seed_source(self.main, self.sibling))
        self.assertTrue(self.hook.seed(self.main, self.sibling))
        self.assertEqual(["branch"], read_index(index_path(self.sibling)))

    def test_a_main_index_its_own_refresh_would_refuse_seeds_nothing(self):
        # The source is judged as a root's own index is: a rollback journal
        # beside it, or a header that is not WAL, refuses it.
        source = write_index(self.main)
        Path(source + "-journal").write_bytes(b"")
        self.assertIsNone(self.hook.seed_source(self.main, self.sibling))
        os.remove(source + "-journal")
        conn = sqlite3.connect(source, isolation_level=None)
        try:
            conn.execute("PRAGMA journal_mode=DELETE")
        finally:
            conn.close()
        self.assertIsNone(self.hook.seed_source(self.main, self.sibling))
        self.assertFalse(self.hook.seed(self.main, self.sibling))
        self.assertFalse(os.path.exists(index_path(self.sibling)))

    def test_a_copy_without_a_wal_header_is_never_renamed_in(self):
        # The header check is what keeps a copy `index_openable` would refuse
        # off the index path. A rollback-mode source, let past its own
        # judgement here, gives exactly such a copy.
        source = write_index(self.main)
        conn = sqlite3.connect(source, isolation_level=None)
        try:
            conn.execute("PRAGMA journal_mode=DELETE")
        finally:
            conn.close()
        real_openable = self.hook.index_openable
        with mock.patch.object(self.hook, "index_openable",
                               side_effect=lambda root: True if real(root) == real(self.main)
                               else real_openable(root)):
            self.assertFalse(self.hook.seed(self.main, self.sibling))
        self.assertFalse(os.path.exists(index_path(self.sibling)))
        self.assertEqual([], [name for name in os.listdir(os.path.dirname(index_path(
            self.sibling))) if ".seed." in name])

    def test_a_file_already_at_the_index_path_is_never_replaced(self):
        # Shorter than a header, so no index, and possibly a file a branch
        # tracks: the main checkout's index never lands on top of it.
        write_index(self.main)
        placeholder = index_path(self.sibling)
        os.makedirs(os.path.dirname(placeholder))
        Path(placeholder).write_bytes(b"placeholder")
        self.assertIsNone(self.hook.seed_source(self.main, self.sibling))
        self.assertFalse(self.hook.refreshable(self.main, self.sibling))
        self.assertFalse(self.hook.seed(self.main, self.sibling))
        self.assertEqual(b"placeholder", Path(placeholder).read_bytes())

    def test_a_killed_workers_partial_is_removed_by_the_next_seed(self):
        # The partial is named for the worker that made it, so one left by a
        # worker killed mid-copy would never be met by a later pid; the next
        # seed, under the same lock, removes it.
        write_index(self.main)
        cache = os.path.dirname(index_path(self.sibling))
        os.makedirs(cache)
        stale = os.path.join(cache, "index.sqlite.seed.99999999")
        Path(stale).write_bytes(b"a full copy, once")
        Path(stale + "-journal").write_bytes(b"")
        self.assertTrue(self.hook.seed(self.main, self.sibling))
        self.assertFalse(os.path.lexists(stale))
        self.assertFalse(os.path.lexists(stale + "-journal"))
        self.assertEqual(["main"], read_index(index_path(self.sibling)))

    def test_a_seed_into_a_redirected_cache_is_refused(self):
        write_index(self.main)
        aimed = os.path.join(self.base, "aimed-at")
        os.mkdir(aimed)
        os.makedirs(os.path.join(self.sibling, ".claude"))
        self.link(os.path.join(self.sibling, ".claude", "cache"), aimed)
        self.assertFalse(self.hook.seed(self.main, self.sibling))
        self.assertEqual([], os.listdir(aimed))

    def edit_event(self, path, cwd):
        return {"cwd": cwd, "hook_event_name": "PostToolUse", "tool_name": "Edit",
                "tool_input": {"file_path": path}}

    def test_an_edit_into_a_worktree_from_the_main_checkout_refreshes_the_worktree(self):
        # blueprint-frontend#137: the session stays in the main checkout and edits a
        # worktree's file by absolute path. The worktree changed; the main
        # checkout did not.
        write_index(self.main)
        edited = os.path.join(self.sibling, "src", "app.ts")
        os.makedirs(os.path.dirname(edited))
        Path(edited).write_text("x", encoding="utf-8")
        event = json.dumps(self.edit_event(edited, self.main))
        with mock.patch.object(self.hook, "home", return_value=self.main), \
                mock.patch.object(self.hook, "spawn") as spawn, \
                mock.patch("sys.stdin", io.StringIO(event)):
            self.assertEqual(0, self.hook.main([]))
        spawn.assert_called_once()
        self.assertEqual(real(self.sibling), real(spawn.call_args.args[0][3]))

    def test_a_relative_path_is_resolved_before_it_is_walked(self):
        # `../../../x` from a worktree under `.claude/worktrees/` lands in the
        # main checkout, whose worktree is among that path's lexical parents.
        nested = os.path.join(self.main, ".claude", "worktrees", "nested")
        git("worktree", "add", "-q", "-b", "nested", nested, cwd=self.main)
        # Through a directory that does not exist: the kernel cannot resolve
        # `missing/..`, so a walk of the unresolved text strips one component
        # at a time and stops in the worktree. Windows resolves `..` as text,
        # so there the case holds either way; POSIX is where it bites.
        event = self.edit_event(
            os.path.join("missing", "..", "..", "..", "..", "README.md"), nested)
        self.assertEqual(real(self.main),
                         real(self.hook.target_root(self.hook.named(event), self.main)))

    def test_a_file_in_a_directory_not_yet_made_names_its_checkout(self):
        event = self.edit_event(
            os.path.join(self.sibling, "new", "deeper", "x.ts"), self.main)
        self.assertEqual(real(self.sibling), real(self.hook.named(event)))

    def test_an_event_naming_a_file_is_never_answered_with_cwd(self):
        # A file that cannot be placed refreshes nothing, never the tree the
        # session stands in, which the change did not touch.
        loose = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, loose, ignore_errors=True)
        outside = self.edit_event(os.path.join(loose, "notes.md"), self.sibling)
        self.assertIsNone(self.hook.target_root(self.hook.named(outside), self.main))
        relative = {"tool_input": {"file_path": "src/app.ts"}}
        self.assertIsNone(self.hook.named(relative))
        # A file with no directory above it that exists — a drive gone, a
        # mount unplugged — walks to the root and stops there.
        placed = self.edit_event(os.path.join(self.sibling, "x.ts"), self.main)
        with mock.patch.object(self.hook.os.path, "isdir", return_value=False):
            self.assertIsNone(self.hook.named(placed))
        for key in ("notebook_path", "file_path"):
            with self.subTest(key=key):
                event = {"cwd": self.main,
                         "tool_input": {key: os.path.join(self.sibling, "n.ipynb")}}
                self.assertEqual(real(self.sibling), real(self.hook.named(event)))

    def test_a_bash_event_follows_its_cwd(self):
        # blueprint-frontend#136: a shell call names no file, so the directory it ran in decides.
        event = {"cwd": self.sibling, "hook_event_name": "PostToolUse",
                 "tool_name": "Bash", "tool_input": {"command": "git commit -m x"}}
        self.assertEqual(self.sibling, self.hook.named(event))
        self.assertEqual(self.main, self.hook.named({"cwd": self.main}))

    @unittest.skipUnless(os.name == "nt", "only Windows searches the working "
                         "directory for a bare name; POSIX searches PATH alone")
    def test_a_program_planted_in_the_working_directory_is_never_run(self):
        # A `bash.cmd` at the owner's root, where the worker runs, must not be
        # found in place of the real one, whatever the launcher passed down.
        planted = Path(self.base, "bash.cmd")
        planted.write_text("@echo planted\r\n", encoding="ascii")
        saved = os.environ.pop("NoDefaultCurrentDirectoryInExePath", None)
        here = os.getcwd()
        try:
            os.chdir(self.base)
            # The control: unset, Windows does find it.
            self.assertTrue(real(self.hook.shutil.which("bash") or "").startswith(
                real(self.base)), "no planted file to refuse")
            hook = load()
            found = hook.shutil.which("bash")
            self.assertEqual("1", os.environ.get("NoDefaultCurrentDirectoryInExePath"))
            self.assertIsNotNone(found, "bash is required: the hook runs nothing without it")
            self.assertFalse(real(found).startswith(real(self.base)), found)
        finally:
            os.chdir(here)
            if saved is None:
                os.environ.pop("NoDefaultCurrentDirectoryInExePath", None)
            else:
                os.environ["NoDefaultCurrentDirectoryInExePath"] = saved

    def test_a_checkout_under_a_non_ascii_path_is_read_as_git_wrote_it(self):
        # Git writes paths as UTF-8. Read in the ANSI code page, `Ł` was a
        # byte cp1252 cannot decode, the reader thread raised where nothing
        # could catch it, and the hook died on every event in that checkout.
        deep = os.path.join(self.base, "Łódź")
        os.mkdir(deep)
        git("init", "-q", cwd=deep)
        found = self.hook.git_paths(deep, self.hook.time.monotonic() + 10)
        self.assertIsNotNone(found)
        self.assertTrue(os.path.samefile(deep, found[0]), found)

    def test_the_event_is_decoded_as_utf_8(self):
        # A Windows pipe reads in the ANSI code page; the bytes are UTF-8.
        payload = json.dumps({"cwd": "C:/\u0141\u00f3d\u017a"}, ensure_ascii=False)
        stream = io.TextIOWrapper(io.BytesIO(payload.encode("utf-8")), encoding="cp1252")
        self.assertEqual("C:/\u0141\u00f3d\u017a", self.hook.read_event(stream)["cwd"])
        for bad in (b"", b"[1]", b"\xff\xfe", b"not json"):
            with self.subTest(payload=bad):
                self.assertIsNone(self.hook.read_event(
                    io.TextIOWrapper(io.BytesIO(bad), encoding="cp1252")))

    def test_a_refused_root_spawns_nothing(self):
        for payload in (json.dumps({"cwd": self.sweep}), "not json", "[]"):
            with self.subTest(payload=payload), \
                    mock.patch.object(self.hook, "home", return_value=self.main), \
                    mock.patch.object(self.hook, "spawn") as spawn, \
                    mock.patch("sys.stdin", io.StringIO(payload)):
                self.assertEqual(0, self.hook.main([]))
                spawn.assert_not_called()

    def test_the_worker_entry_point_judges_its_root_again(self):
        for argv in (["--worker", self.sweep],
                     ["--worker", self.sibling, "extra"],
                     ["--worker"]):
            with self.subTest(argv=argv), \
                    mock.patch.object(self.hook, "home", return_value=self.main), \
                    mock.patch.object(self.hook, "work") as work:
                self.assertEqual(0, self.hook.main(argv))
                work.assert_not_called()

    def test_a_forged_git_file_is_refused(self):
        # Copilot, round 2: a directory whose `.git` file names this
        # repository's worktree admin directory reports its common directory
        # without git having made it. The admin directory's backlink names the
        # real worktree, not this one.
        forged = os.path.join(self.base, "forged")
        os.mkdir(forged)
        admin = Path(self.sibling, ".git").read_text(encoding="utf-8").split(":", 1)[1].strip()
        Path(forged, ".git").write_text(f"gitdir: {admin}\n", encoding="utf-8")
        self.assertIsNone(self.hook.target_root(forged, self.main))
        # And the registered worktree it borrowed from is still accepted.
        self.assertIsNotNone(self.hook.target_root(self.sibling, self.main))

    def test_a_git_directory_is_only_ever_the_owners_checkout(self):
        # The same claim through a directory rather than a file: a `.git`
        # linked to this repository's own. Where the platform grants no link
        # primitive, the check is driven directly instead of skipped.
        linked = os.path.join(self.base, "linked")
        os.mkdir(linked)
        try:
            os.symlink(os.path.join(self.main, ".git"), os.path.join(linked, ".git"),
                       target_is_directory=True)
        except (OSError, NotImplementedError):
            if os.name != "nt":
                raise
            subprocess.run(
                ["cmd", "/c", "mklink", "/J", os.path.join(linked, ".git"),
                 os.path.join(self.main, ".git")],
                check=True, capture_output=True)
        self.assertIsNone(self.hook.target_root(linked, self.main))
        self.assertFalse(self.hook.registered(linked, self.main, self.common))
        self.assertTrue(self.hook.registered(self.main, self.main, self.common))

    def test_an_admin_directory_outside_the_repository_is_refused(self):
        # Copilot, round 4: the backlink proves only that the admin directory
        # agrees with the marker, and whoever forged the marker can forge the
        # admin directory too — a `gitdir` pointing back and a `commondir`
        # naming this repository. Git itself then reports this repository's
        # common directory, so only containment under `<common>/worktrees/`
        # refuses it.
        forged = os.path.join(self.base, "forged-admin")
        admin = os.path.join(self.base, "elsewhere", "worktrees", "forged")
        os.makedirs(forged)
        os.makedirs(admin)
        Path(forged, ".git").write_text(f"gitdir: {admin}\n", encoding="utf-8")
        Path(admin, "gitdir").write_text(
            os.path.join(forged, ".git") + "\n", encoding="utf-8")
        Path(admin, "commondir").write_text(self.common + "\n", encoding="utf-8")
        Path(admin, "HEAD").write_text("ref: refs/heads/feature\n", encoding="utf-8")
        # The forgery is good enough to fool git: this is the premise.
        owner_common = self.hook.git_paths(self.main, self.hook.time.monotonic() + 5)[1]
        seen = self.hook.git_paths(forged, self.hook.time.monotonic() + 5)
        self.assertIsNotNone(seen)
        self.assertTrue(self.hook.same(seen[1], owner_common))
        self.assertIsNone(self.hook.target_root(forged, self.main))

    def test_a_hard_linked_git_file_is_refused(self):
        # Copilot, round 8: a hard link is neither a symlink nor a junction,
        # and it is the same inode, so it inherits the worktree's backlink and
        # passes every identity comparison. Git never makes a second name for
        # a `.git` file, so a marker with more than one link is somebody's.
        forged = os.path.join(self.base, "forged-hardlink")
        os.mkdir(forged)
        marker = os.path.join(forged, ".git")
        try:
            os.link(os.path.join(self.sibling, ".git"), marker)
        except (OSError, NotImplementedError, AttributeError) as error:
            self.fail(f"a hard link is the premise of this case: {error}")
        self.assertGreater(os.stat(marker).st_nlink, 1)
        self.assertFalse(self.hook.registered(forged, self.main, self.common))
        self.assertIsNone(self.hook.target_root(forged, self.main))
        # The cost, stated rather than discovered: a link raises the count on
        # both names, so the real worktree is refused too while it exists.
        # Somebody who can write beside the repository can stop a worktree
        # being refreshed; they still cannot have their own tree indexed.
        self.assertIsNone(self.hook.target_root(self.sibling, self.main))
        os.remove(marker)
        self.assertEqual(1, os.stat(os.path.join(self.sibling, ".git")).st_nlink)
        self.assertIsNotNone(self.hook.target_root(self.sibling, self.main))

    def test_a_git_file_reached_through_a_link_is_refused(self):
        # Copilot, round 3: `isfile`, `open` and `realpath` all follow a link,
        # so a `.git` linking to a registered worktree's own `.git` file read
        # that worktree's admin directory, whose backlink named the same file.
        # A file link needs a privilege Windows may not grant. Where it is
        # refused, the link is emulated as the hook would see one: `islink`
        # reports it, and `realpath` resolves it to the worktree's own `.git`
        # file. A copy alone would be refused by the backlink whether or not
        # links are, and prove nothing.
        forged = os.path.join(self.base, "forged-link")
        os.mkdir(forged)
        marker = os.path.join(forged, ".git")
        target = os.path.join(self.sibling, ".git")
        try:
            os.symlink(target, marker)
        except (OSError, NotImplementedError):
            if os.name != "nt":
                raise
            shutil.copyfile(target, marker)
            realpath = os.path.realpath

            def is_marker(path):
                # Not `real()`: that calls the `realpath` patched below.
                return (os.path.normcase(os.path.abspath(path))
                        == os.path.normcase(os.path.abspath(marker)))

            identity = self.hook.same

            def through_link(p):
                return target if is_marker(p) else p

            # A link is the entry it points at to `realpath` and to identity.
            with mock.patch.object(self.hook.os.path, "islink", side_effect=is_marker), \
                    mock.patch.object(
                        self.hook.os.path, "realpath",
                        side_effect=lambda p, *a, **k: realpath(through_link(p), *a, **k)), \
                    mock.patch.object(
                        self.hook, "same",
                        side_effect=lambda a, b: identity(through_link(a), through_link(b))):
                self.assertFalse(self.hook.registered(forged, self.main, self.common))
            return
        self.assertFalse(self.hook.registered(forged, self.main, self.common))
        self.assertIsNone(self.hook.target_root(forged, self.main))


class OneWorkerPerRootAndNoEditDropped(unittest.TestCase):
    """Copilot, rounds 1 to 3: one worker per root, and no edit dropped.

    Round 1 found refreshes racing. Rounds 2 and 3 found the lock file that
    fixed it needing an age, then a token, then a check-then-act a takeover
    could slip between. The lock is the operating system's now, so these
    cases hold it the way a worker does: from another handle in this process,
    and from another process that then dies.
    """

    def setUp(self):
        self.hook = load()
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        # A real repository, because the state now lives in its git
        # directory: no repository, no refresh at all.
        git("init", "-q", cwd=self.root)

    def hold(self):
        lock = self.hook.Lock(self.root, self.root)
        self.assertTrue(lock.acquire())
        self.addCleanup(lock.release)
        return lock

    def test_an_edit_during_a_run_leaves_a_marker_and_starts_nothing(self):
        self.hold()
        with mock.patch.object(self.hook, "spawn") as spawn:
            self.hook.start(self.root, self.root)
        spawn.assert_not_called()
        self.assertTrue(os.path.isfile(self.hook.pending_path(self.root, self.root)))

    def test_an_edit_with_no_worker_marks_and_starts_one(self):
        with mock.patch.object(self.hook, "spawn") as spawn:
            self.hook.start(self.root, self.root)
        spawn.assert_called_once()
        self.assertTrue(os.path.isfile(self.hook.pending_path(self.root, self.root)))
        self.assertFalse(self.hook.held(self.root, self.root))

    def test_a_second_worker_finds_the_lock_held_and_runs_nothing(self):
        self.hold()
        self.hook.mark_pending(self.root, self.root)
        with mock.patch.object(self.hook, "refresh") as refresh:
            self.hook.work(self.root, self.root)
        refresh.assert_not_called()

    def test_edits_during_a_run_earn_exactly_one_more_run(self):
        runs = []

        def refresh(owner, root, lock):
            runs.append(root)
            if len(runs) == 1:
                # Three edits arrive while the first run is going.
                for _ in range(3):
                    self.hook.start(owner, root)

        self.hook.mark_pending(self.root, self.root)
        with mock.patch.object(self.hook, "refresh", side_effect=refresh), \
                mock.patch.object(self.hook, "spawn") as spawn:
            self.hook.work(self.root, self.root)
        self.assertEqual(2, len(runs))
        spawn.assert_not_called()
        self.assertFalse(self.hook.held(self.root, self.root))
        self.assertFalse(os.path.exists(self.hook.pending_path(self.root, self.root)))

    def test_a_marker_left_as_the_lock_is_released_is_still_served(self):
        # The window the look after letting go closes: an edit that found the
        # lock held, but marked only after the worker's last look inside it.
        runs = []
        real_release = self.hook.Lock.release

        def release(lock):
            real_release(lock)
            if len(runs) == 1:
                self.hook.mark_pending(self.root, self.root)

        self.hook.mark_pending(self.root, self.root)
        with mock.patch.object(self.hook, "refresh",
                               side_effect=lambda o, r, lock: runs.append(r)), \
                mock.patch.object(self.hook.Lock, "release", release):
            self.hook.work(self.root, self.root)
        self.assertEqual(2, len(runs))
        self.assertFalse(self.hook.held(self.root, self.root))

    def test_a_worker_that_dies_holding_the_lock_releases_it(self):
        # The case the lock file needed an age for. A second process takes the
        # lock, reports it, and is killed without releasing anything.
        child = subprocess.Popen(
            [sys.executable, "-c",
             "import importlib.util, sys\n"
             "spec = importlib.util.spec_from_file_location('h', sys.argv[1])\n"
             "h = importlib.util.module_from_spec(spec)\n"
             "spec.loader.exec_module(h)\n"
             "lock = h.Lock(sys.argv[2], sys.argv[2])\n"
             "print('held' if lock.acquire() else 'refused', flush=True)\n"
             "sys.stdin.read()\n",
             str(HOOK), self.root],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual("held", child.stdout.readline().strip())
            self.assertTrue(self.hook.held(self.root, self.root))
        finally:
            child.kill()
            child.wait(timeout=30)
            child.stdin.close()
            child.stdout.close()
        self.assertFalse(self.hook.held(self.root, self.root))

    def test_every_marker_the_worker_removes_is_followed_by_a_refresh(self):
        # Copilot, round 4, suppressed: a worker unlinking a marker an edit
        # still has open was read as a lost edit. The marker never carries
        # the edit — the hook runs after the edit is on disk — so what makes
        # that safe is this invariant: a marker is only ever consumed as the
        # first step of a refresh.
        events = []
        take = self.hook.take_pending

        def recording_take(owner, root):
            taken = take(owner, root)
            events.append(("take", taken))
            return taken

        def refresh(owner, root, lock):
            events.append(("refresh",))
            if events.count(("refresh",)) == 1:
                self.hook.mark_pending(owner, root)

        self.hook.mark_pending(self.root, self.root)
        with mock.patch.object(self.hook, "take_pending", side_effect=recording_take), \
                mock.patch.object(self.hook, "refresh", side_effect=refresh):
            self.hook.work(self.root, self.root)
        for i, event in enumerate(events):
            if event == ("take", True):
                self.assertEqual(("refresh",), events[i + 1], events)
        self.assertEqual(2, events.count(("refresh",)))

    def test_a_marker_that_will_not_go_ends_the_worker(self):
        # Copilot, round 8: a failed removal reported as an absent marker
        # ended the inner loop, and the outer loop took the lock again and
        # met the same marker, for ever. A marker that will not go ends the
        # worker and waits for the next edit.
        self.hook.mark_pending(self.root, self.root)
        with mock.patch.object(self.hook.os, "remove",
                               side_effect=PermissionError(13, "in use")), \
                mock.patch.object(self.hook, "refresh") as refresh:
            # In a thread with a deadline: the defect does not fail this
            # case, it never finishes it, and a suite that hangs reports
            # nothing at all.
            worker = threading.Thread(
                target=self.hook.work, args=(self.root, self.root), daemon=True)
            worker.start()
            worker.join(30)
        self.assertFalse(worker.is_alive(), "the worker is spinning on the marker")
        refresh.assert_not_called()
        self.assertTrue(os.path.exists(self.hook.pending_path(self.root, self.root)))
        self.assertFalse(self.hook.held(self.root, self.root))

    def test_a_failed_removal_is_not_an_absent_marker(self):
        self.assertIs(False, self.hook.take_pending(self.root, self.root))
        self.hook.mark_pending(self.root, self.root)
        with mock.patch.object(self.hook.os, "remove",
                               side_effect=PermissionError(13, "in use")):
            self.assertIsNone(self.hook.take_pending(self.root, self.root))
        self.assertIs(True, self.hook.take_pending(self.root, self.root))

    def test_an_indexer_left_running_by_a_killed_worker_keeps_the_tree(self):
        # Copilot, round 8: the lock is the worker's, not the indexer's, so a
        # worker killed mid-run left `run-index` behind and the next edit
        # started a second one against the same cache. The lock records the
        # child's pid, and a worker that finds it still running stands off.
        child = subprocess.Popen([sys.executable, "-c", "import sys; sys.stdin.read()"],
                                 stdin=subprocess.PIPE)

        def stop():
            # Kill before waiting: a failing assertion must not leave the
            # suite waiting on a child nothing has told to stop.
            child.kill()
            child.wait(timeout=30)
            child.stdin.close()

        self.addCleanup(stop)
        lock = self.hook.Lock(self.root, self.root)
        self.assertTrue(lock.acquire())
        lock.write(str(child.pid))
        lock.release()

        self.hook.mark_pending(self.root, self.root)
        with mock.patch.object(self.hook, "refresh") as refresh:
            self.hook.work(self.root, self.root)
        refresh.assert_not_called()
        self.assertTrue(os.path.exists(self.hook.pending_path(self.root, self.root)))

        stop()
        with mock.patch.object(self.hook, "refresh") as refresh:
            self.hook.work(self.root, self.root)
        refresh.assert_called_once()

    def test_the_worker_claims_the_record_before_the_child_exists(self):
        # Copilot, round 9: a worker killed between `Popen` and the write left
        # an indexer nobody could name, so the next edit started a second one.
        # The worker's own pid holds the record until the child's is known.
        claims = []
        write_index(self.root)
        lock = self.hook.Lock(self.root, self.root)
        self.assertTrue(lock.acquire())
        self.addCleanup(lock.release)
        real_write = lock.write

        def record(text):
            claims.append(text)
            real_write(text)

        with mock.patch.object(lock, "write", side_effect=record), \
                mock.patch.object(self.hook.subprocess, "Popen") as popen:
            popen.return_value.pid = 4242
            self.hook.refresh(self.root, self.root, lock)
        self.assertEqual([str(os.getpid()), "4242", ""], claims)

    def test_the_child_is_reaped_before_the_record_is_cleared(self):
        # The other half: `kill` only asks. A record cleared while the process
        # is still exiting lets a coalesced refresh start beside it.
        order = []
        write_index(self.root)
        child = mock.Mock()
        child.pid = 4242
        waits = []

        def wait(timeout=None):
            waits.append(timeout)
            if len(waits) == 1:
                raise subprocess.TimeoutExpired("run-index", 1)
            order.append("reaped")

        child.wait.side_effect = wait
        child.kill.side_effect = lambda: order.append("killed")
        lock = mock.Mock()
        lock.write.side_effect = lambda text: order.append(f"write {text!r}")
        with mock.patch.object(self.hook.subprocess, "Popen", return_value=child):
            self.hook.refresh(self.root, self.root, lock)
        self.assertEqual("killed", order[order.index("reaped") - 1])
        self.assertEqual("write ''", order[-1])

    def test_a_process_is_alive_only_while_it_runs(self):
        self.assertTrue(self.hook.alive(os.getpid()))
        child = subprocess.Popen([sys.executable, "-c", "pass"])
        child.wait(timeout=30)
        self.assertFalse(self.hook.alive(child.pid))
        self.assertFalse(self.hook.alive(0))

    def test_the_lock_file_is_never_removed(self):
        # A lock removed by path can be pulled from under its holder; one held
        # on a handle and left in place cannot.
        self.hook.mark_pending(self.root, self.root)
        with mock.patch.object(self.hook, "refresh"):
            self.hook.work(self.root, self.root)
        self.assertTrue(os.path.isfile(self.hook.lock_path(self.root, self.root)))


class TheIndexIsCompactedAfterARefresh(unittest.TestCase):
    """alexander-shamray/blueprint-frontend#128: the package never compacts.

    Against a real SQLite file in the package's own full-text shape — a
    `chunks` table and an external-content FTS5 table over it — because a
    stand-in for SQLite would test the stand-in. The two kinds of bloat the
    issue measured are built apart as well as together, and each case asserts
    the other threshold is not met, so a measure that stopped being read fails
    a case of its own. Automerge is off in the fixture and the crisis merge
    raised: that is the quickest way to the segment count the issue measured,
    not how the package reached it.
    """

    def setUp(self):
        self.hook = load()
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        # A real repository, because the worker's lock lives in its git
        # directory.
        git("init", "-q", cwd=self.root)
        self.index = os.path.join(self.root, ".claude", "cache", "codebase-index",
                                  "index.sqlite")
        os.makedirs(os.path.dirname(self.index))
        # The cases build FTS5 tables and `shaped` reads `PRAGMA table_list`,
        # so a Python linked to an older SQLite fails here, saying why,
        # rather than case by case with no named cause.
        self.assertGreaterEqual(sqlite3.sqlite_version_info, (3, 37, 0),
                                "the compaction cases need SQLite 3.37 or later")

    def build(self, *, segments=False, free=False):
        conn = sqlite3.connect(self.index, isolation_level=None)
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("CREATE TABLE chunks (id INTEGER PRIMARY KEY, content TEXT)")
            conn.execute("CREATE VIRTUAL TABLE fts_chunks USING fts5("
                         "content, content='chunks', content_rowid='id')")
            conn.execute("INSERT INTO fts_chunks(fts_chunks, rank) VALUES('automerge', 0)")
            conn.execute(
                "INSERT INTO fts_chunks(fts_chunks, rank) VALUES('crisismerge', 1000)")
            conn.execute("BEGIN")
            for i in range(1, 11):
                conn.execute("INSERT INTO chunks VALUES (?, ?)", (i, f"chunk {i} alpha"))
                conn.execute("INSERT INTO fts_chunks(rowid, content) VALUES (?, ?)",
                             (i, f"chunk {i} alpha"))
            conn.execute("COMMIT")
            if segments:
                # A delete and an insert per transaction, each its own
                # segment: an `update` re-indexing a file, two hundred times.
                for n in range(200):
                    i = n % 10 + 1
                    old = conn.execute("SELECT content FROM chunks WHERE id = ?",
                                       (i,)).fetchone()[0]
                    new = f"chunk {i} alpha round {n}"
                    conn.execute("INSERT INTO fts_chunks(fts_chunks, rowid, content) "
                                 "VALUES('delete', ?, ?)", (i, old))
                    conn.execute("UPDATE chunks SET content = ? WHERE id = ?", (new, i))
                    conn.execute("INSERT INTO fts_chunks(rowid, content) VALUES (?, ?)",
                                 (i, new))
            if free:
                # Pages a dropped table gave back, which nothing reclaims
                # while `auto_vacuum` is off.
                conn.execute("CREATE TABLE filler (b BLOB)")
                conn.execute("INSERT INTO filler VALUES (zeroblob(2000000))")
                conn.execute("DROP TABLE filler")
        finally:
            conn.close()

    def measure(self):
        conn = sqlite3.connect(self.index)
        try:
            return {
                "pages": conn.execute("PRAGMA page_count").fetchone()[0],
                "free": conn.execute("PRAGMA freelist_count").fetchone()[0],
                "rows": conn.execute("SELECT count(*) FROM fts_chunks_data").fetchone()[0],
                "hits": conn.execute("SELECT count(*) FROM fts_chunks "
                                     "WHERE fts_chunks MATCH 'alpha'").fetchone()[0],
            }
        finally:
            conn.close()

    def snapshot(self):
        with open(self.index, "rb") as handle:
            return handle.read(), os.stat(self.index).st_mtime_ns

    def test_a_bloated_index_is_compacted(self):
        self.build(segments=True, free=True)
        before = os.path.getsize(self.index)
        self.assertTrue(self.hook.compact(self.root))
        after = self.measure()
        self.assertLess(os.path.getsize(self.index), before / 4)
        self.assertEqual(0, after["free"])
        self.assertLessEqual(after["rows"], 10)
        # Merged, not lost: every chunk is still found, and FTS5 agrees.
        self.assertEqual(10, after["hits"])
        conn = sqlite3.connect(self.index)
        try:
            conn.execute("INSERT INTO fts_chunks(fts_chunks) VALUES('integrity-check')")
        finally:
            conn.close()

    def test_free_pages_alone_are_enough(self):
        self.build(free=True)
        before = self.measure()
        self.assertGreater(before["free"], before["pages"] * self.hook.FREE_SHARE)
        self.assertLessEqual(before["rows"], self.hook.ROWS_PER_CHUNK * 10)
        self.assertTrue(self.hook.compact(self.root))
        self.assertEqual(0, self.measure()["free"])

    def test_segment_rows_alone_are_enough(self):
        self.build(segments=True)
        before = self.measure()
        self.assertLessEqual(before["free"], before["pages"] * self.hook.FREE_SHARE)
        self.assertGreater(before["rows"], self.hook.ROWS_PER_CHUNK * 10)
        self.assertTrue(self.hook.compact(self.root))
        self.assertLessEqual(self.measure()["rows"], 10)

    def test_a_lean_index_is_left_as_it_is(self):
        self.build()
        before = self.snapshot()
        self.assertFalse(self.hook.compact(self.root))
        self.assertEqual(before, self.snapshot())

    def test_an_index_of_another_shape_is_left_as_it_is(self):
        # A package release that renames these tables must cost a large
        # index, never a broken one or a worker that dies. In WAL mode, so
        # the shape check and not the header check is what refuses it.
        conn = sqlite3.connect(self.index)
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("CREATE TABLE other (x)")
        finally:
            conn.close()
        before = self.snapshot()
        self.assertFalse(self.hook.compact(self.root))
        self.assertEqual(before, self.snapshot())

    def test_no_index_is_not_created(self):
        # `sqlite3.connect` creates what it cannot find.
        self.assertFalse(self.hook.compact(self.root))
        self.assertFalse(os.path.exists(self.index))

    def test_a_linked_index_is_not_compacted(self):
        self.build(segments=True, free=True)
        aimed = os.path.join(self.root, "aimed-at.sqlite")
        os.replace(self.index, aimed)
        try:
            os.symlink(aimed, self.index)
        except (OSError, NotImplementedError):
            self.skipTest("this platform grants no file symlink here")
        size = os.path.getsize(aimed)
        self.assertFalse(self.hook.compact(self.root))
        self.assertEqual(size, os.path.getsize(aimed))

    # The directory-link primitive the root cases use.
    link = TheRootFollowsTheActiveWorktree.link

    def test_a_linked_sidecar_is_refused(self):
        # SQLite opens these by name beside the database, so a link at one
        # aims the checkpoint's write and truncation where the branch chose.
        # Named here rather than read from the hook, so the case judges what
        # SQLite opens and not what the hook says it checks.
        self.build(segments=True, free=True)
        aimed = os.path.join(self.root, "aimed-at")
        Path(aimed).write_bytes(b"keep")
        for suffix in ("-wal", "-shm", "-journal"):
            with self.subTest(suffix=suffix):
                try:
                    os.symlink(aimed, self.index + suffix)
                except (OSError, NotImplementedError):
                    self.skipTest("this platform grants no file symlink here")
                try:
                    with mock.patch.object(self.hook.sqlite3, "connect") as connect:
                        self.assertFalse(self.hook.compact(self.root))
                    connect.assert_not_called()
                finally:
                    os.remove(self.index + suffix)
        self.assertEqual(b"keep", Path(aimed).read_bytes())

    def test_a_cache_directory_linked_since_the_root_was_judged_is_refused(self):
        # `target_root` judged the cache path long before the rewrite — the
        # `compact` docstring says why — and a checkout in between can put a
        # link on it.
        self.build(segments=True, free=True)
        cache = os.path.join(self.root, ".claude", "cache")
        moved = os.path.join(self.root, "moved-cache")
        os.replace(cache, moved)
        self.link(cache, moved)
        with mock.patch.object(self.hook.sqlite3, "connect") as connect:
            self.assertFalse(self.hook.compact(self.root))
        connect.assert_not_called()

    def test_a_compaction_past_its_deadline_is_interrupted(self):
        # The shape check keeps a view out and the connection switches
        # triggers off, so what the deadline still bounds is the package's
        # own tables, however large.
        # A deadline already spent stops the compaction before `VACUUM` gives
        # any page back, so a bloated index of the real shape is not
        # compacted; the short statements before it run inside one interval
        # of the handler. In a thread, so a regression fails this case rather
        # than hanging the suite.
        self.build(segments=True, free=True)
        conn = sqlite3.connect(self.index, isolation_level=None)
        try:
            # Enough rows that `VACUUM` outlasts the handler's interval; a
            # fixture this small otherwise finishes between two of its calls.
            conn.execute("INSERT INTO chunks(content) SELECT 'padding ' || value FROM "
                         "(WITH RECURSIVE r(value) AS (SELECT 1 UNION ALL "
                         "SELECT value + 1 FROM r LIMIT 5000) SELECT value FROM r)")
        finally:
            conn.close()
        measured = self.measure()
        self.assertGreater(measured["free"], measured["pages"] * self.hook.FREE_SHARE)
        result = []
        worker = threading.Thread(
            target=lambda: result.append(self.hook.compact(self.root)), daemon=True)
        with mock.patch.object(self.hook, "COMPACT_TIMEOUT", -1):
            worker.start()
            worker.join(timeout=30)
        self.assertFalse(worker.is_alive(), "compaction ran past its deadline")
        self.assertEqual([False], result)
        # `optimize` may already have committed — the docstring's valid index,
        # merged and not yet reclaimed — but the interrupted `VACUUM` gave no
        # page back, and the index is whole.
        self.assertGreater(self.measure()["free"], 0)
        conn = sqlite3.connect(self.index)
        try:
            conn.execute("INSERT INTO fts_chunks(fts_chunks) VALUES('integrity-check')")
        finally:
            conn.close()

    def test_a_sqlite_that_cannot_distrust_the_schema_compacts_nothing(self):
        # SQLite before 3.31 ignores `trusted_schema` without an error, so the
        # pragma is read back rather than assumed. The old library is played
        # by a connection that answers the read-back with no row, as it would.
        self.build(segments=True, free=True)
        before = self.snapshot()
        real_connect = sqlite3.connect

        class Old(sqlite3.Connection):
            def execute(self, sql, *args):
                if sql == "PRAGMA trusted_schema":
                    return super().execute("SELECT 1 WHERE 0")
                return super().execute(sql, *args)

        with mock.patch.object(self.hook.sqlite3, "connect",
                               lambda *a, **k: real_connect(*a, factory=Old, **k)):
            self.assertFalse(self.hook.compact(self.root))
        self.assertEqual(before, self.snapshot())

    def refresh_exiting(self, wait):
        # An index to update: with none and none to seed, nothing runs.
        self.build()
        child = mock.Mock(pid=4242)
        child.wait.side_effect = wait
        with mock.patch.object(self.hook.subprocess, "Popen", return_value=child), \
                mock.patch.object(self.hook, "compact") as compact:
            self.hook.refresh(self.root, self.root, mock.Mock())
        return compact

    def test_only_an_index_at_rest_in_wal_mode_may_be_opened(self):
        # No index yet is admitted, since the worker seeds one; a WAL-mode
        # index is admitted; a journal beside it, or a rollback-mode header,
        # refuses it at every point that opens it.
        self.assertTrue(self.hook.index_openable(self.root))
        self.build(segments=True, free=True)
        self.assertTrue(self.hook.index_openable(self.root))
        journal = self.index + "-journal"
        Path(journal).write_bytes(b"")
        self.assertFalse(self.hook.index_openable(self.root))
        with mock.patch.object(self.hook.subprocess, "Popen") as popen:
            self.hook.refresh(self.root, self.root, mock.Mock())
        popen.assert_not_called()
        with mock.patch.object(self.hook.sqlite3, "connect") as connect:
            self.assertFalse(self.hook.compact(self.root))
        connect.assert_not_called()
        os.remove(journal)
        conn = sqlite3.connect(self.index, isolation_level=None)
        try:
            conn.execute("PRAGMA journal_mode=DELETE")
        finally:
            conn.close()
        self.assertFalse(self.hook.index_openable(self.root))

    def test_a_file_of_another_shape_runs_none_of_its_schema(self):
        # A plain `fts_chunks` table can carry a trigger the `optimize` insert
        # would fire; the shape check refuses it before any statement reads
        # a table, so the trigger's write never happens.
        conn = sqlite3.connect(self.index, isolation_level=None)
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("CREATE TABLE chunks (id INTEGER PRIMARY KEY, content TEXT)")
            conn.execute("CREATE TABLE fts_chunks_data (id INTEGER PRIMARY KEY, block BLOB)")
            # The comment is stored in `sqlite_master.sql`, so a check of the
            # text would take this plain table for FTS5.
            conn.execute("CREATE TABLE fts_chunks (fts_chunks TEXT /* using fts5 */)")
            conn.execute("CREATE TABLE fired (n INTEGER)")
            conn.execute("CREATE TRIGGER planted AFTER INSERT ON fts_chunks "
                         "BEGIN INSERT INTO fired VALUES (1); END")
            conn.execute("INSERT INTO fts_chunks_data SELECT value, NULL FROM "
                         "(WITH RECURSIVE r(value) AS (SELECT 1 UNION ALL "
                         "SELECT value + 1 FROM r LIMIT 50) SELECT value FROM r)")
        finally:
            conn.close()
        self.assertFalse(self.hook.compact(self.root))
        conn = sqlite3.connect(self.index)
        try:
            self.assertEqual(0, conn.execute("SELECT count(*) FROM fired").fetchone()[0])
        finally:
            conn.close()

    def test_a_trigger_in_the_file_never_runs(self):
        # `optimize` writes `fts_chunks_data` through FTS5's own statements,
        # so a trigger planted there would fire on an index of the real
        # shape. Triggers are off on the compaction's connection, so none
        # runs however its table is spelled: `sqlite_master` keeps the case a
        # trigger was declared with, and SQLite resolves it folded.
        for spelling in ("fts_chunks_data", "FTS_CHUNKS_DATA"):
            with self.subTest(spelling=spelling):
                for suffix in ("", "-wal", "-shm"):
                    if os.path.exists(self.index + suffix):
                        os.remove(self.index + suffix)
                self.build(segments=True, free=True)
                conn = sqlite3.connect(self.index, isolation_level=None)
                try:
                    conn.execute("CREATE TABLE fired (n INTEGER)")
                    conn.execute(f"CREATE TRIGGER planted AFTER INSERT ON {spelling} "
                                 "BEGIN INSERT INTO fired VALUES (1); END")
                finally:
                    conn.close()
                self.assertTrue(self.hook.compact(self.root))
                conn = sqlite3.connect(self.index)
                try:
                    self.assertEqual(
                        0, conn.execute("SELECT count(*) FROM fired").fetchone()[0])
                finally:
                    conn.close()

    def test_triggers_that_will_not_switch_off_compact_nothing(self):
        # The switch is read back with `getconfig`, because `setconfig`
        # returns nothing. Played by a connection whose `setconfig` takes no
        # effect, which leaves triggers on as SQLite's default has them.
        self.build(segments=True, free=True)
        before = self.snapshot()
        real_connect = sqlite3.connect

        class Stuck(sqlite3.Connection):
            def setconfig(self, *args):
                return None

        with mock.patch.object(self.hook.sqlite3, "connect",
                               lambda *a, **k: real_connect(*a, factory=Stuck, **k)):
            self.assertFalse(self.hook.compact(self.root))
        self.assertEqual(before, self.snapshot())

    def test_a_checkpoint_held_back_by_a_reader_is_not_reported_done(self):
        # A reader holding a snapshot makes `wal_checkpoint(TRUNCATE)` report
        # busy rather than raise, and the rewritten file then waits in the
        # `-wal`; `compact` must not report that as a finished compaction.
        self.build(segments=True, free=True)
        reader = sqlite3.connect(self.index, isolation_level=None)
        self.addCleanup(reader.close)
        reader.execute("BEGIN")
        reader.execute("SELECT count(*) FROM chunks").fetchone()
        with mock.patch.object(self.hook.sqlite3, "connect",
                               lambda *a, **k: sqlite3.Connection(
                                   *a, **{**k, "timeout": 0.1})):
            self.assertFalse(self.hook.compact(self.root))
        reader.execute("COMMIT")

    def test_a_plain_table_named_in_capitals_is_refused(self):
        # SQLite resolves names folded, so `FTS_CHUNKS_DATA` is the table
        # `bloated` counts; the shape check folds them the same way, and a
        # plain table under that name is refused.
        conn = sqlite3.connect(self.index, isolation_level=None)
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("CREATE TABLE chunks (id INTEGER PRIMARY KEY, content TEXT)")
            conn.execute("CREATE TABLE FTS_CHUNKS_DATA (id INTEGER PRIMARY KEY, block BLOB)")
            conn.execute("CREATE TABLE fts_chunks (fts_chunks TEXT)")
            conn.execute("INSERT INTO FTS_CHUNKS_DATA SELECT value, NULL FROM "
                         "(WITH RECURSIVE r(value) AS (SELECT 1 UNION ALL "
                         "SELECT value + 1 FROM r LIMIT 50) SELECT value FROM r)")
        finally:
            conn.close()
        before = self.snapshot()
        self.assertFalse(self.hook.compact(self.root))
        self.assertEqual(before, self.snapshot())

    def test_a_table_named_outside_ascii_is_refused(self):
        # SQLite folds ASCII only, and Python's `lower()` folds a KELVIN SIGN
        # onto `k`, so a name outside ASCII could meet a real one on a key.
        # Any such name refuses the file, wherever it sits in the listing: an
        # index otherwise of the real shape is left alone.
        self.build(segments=True, free=True)
        conn = sqlite3.connect(self.index, isolation_level=None)
        try:
            conn.execute('CREATE TABLE "chun\u212as_elsewhere" (x)')
        finally:
            conn.close()
        before = self.snapshot()
        self.assertFalse(self.hook.compact(self.root))
        self.assertEqual(before, self.snapshot())

    def test_an_index_a_first_build_has_not_written_is_admitted(self):
        # A first build creates the file before it writes the header, and a
        # build that dies there must not refuse the root for good.
        Path(self.index).write_bytes(b"")
        self.assertTrue(self.hook.index_openable(self.root))
        self.assertFalse(self.hook.written(self.root))
        Path(self.index + "-journal").write_bytes(b"")
        self.assertFalse(self.hook.index_openable(self.root))

    def test_a_view_in_place_of_chunks_is_refused(self):
        # `bloated` counts `chunks`, and a view runs its query when counted,
        # so it must be a plain table.
        self.build(segments=True, free=True)
        conn = sqlite3.connect(self.index, isolation_level=None)
        try:
            conn.execute("DROP TABLE chunks")
            conn.execute("CREATE VIEW chunks AS SELECT 1 AS id")
        finally:
            conn.close()
        before = self.snapshot()
        self.assertFalse(self.hook.compact(self.root))
        self.assertEqual(before, self.snapshot())

    def test_a_sqlite_without_table_list_compacts_nothing(self):
        # SQLite before 3.37 has no `table_list` and answers it with no row,
        # which the shape check must read as unknown and never as clean.
        # Played by a connection that answers the pragma the same way.
        self.build(segments=True, free=True)
        before = self.snapshot()
        real_connect = sqlite3.connect

        class Old(sqlite3.Connection):
            def execute(self, sql, *args):
                if sql == "PRAGMA main.table_list":
                    return super().execute("SELECT 1 WHERE 0")
                return super().execute(sql, *args)

        with mock.patch.object(self.hook.sqlite3, "connect",
                               lambda *a, **k: real_connect(*a, factory=Old, **k)):
            self.assertFalse(self.hook.compact(self.root))
        self.assertEqual(before, self.snapshot())

    def test_a_view_among_the_shadow_names_is_refused(self):
        # Every `fts_chunks_` name must be FTS5's own shadow table; a view
        # there is something the file's author wrote, not the package.
        self.build(segments=True, free=True)
        conn = sqlite3.connect(self.index, isolation_level=None)
        try:
            conn.execute("CREATE VIEW fts_chunks_extra AS SELECT 1 AS x")
        finally:
            conn.close()
        before = self.snapshot()
        self.assertFalse(self.hook.compact(self.root))
        self.assertEqual(before, self.snapshot())

    def test_a_wrapper_run_is_judged_again_after_the_root_was(self):
        # A worker judges its root once and then refreshes for as long as
        # edits keep coming, so a checkout that links the cache path between
        # two runs must stop the second one before the wrapper writes.
        self.build()
        with mock.patch.object(self.hook.subprocess, "Popen") as popen:
            popen.return_value.wait.return_value = 1
            self.hook.refresh(self.root, self.root, mock.Mock())
        popen.assert_called_once()
        cache = os.path.join(self.root, ".claude", "cache")
        moved = os.path.join(self.root, "moved-cache")
        os.replace(cache, moved)
        self.link(cache, moved)
        with mock.patch.object(self.hook.subprocess, "Popen") as popen:
            self.hook.refresh(self.root, self.root, mock.Mock())
        popen.assert_not_called()

    def test_a_refresh_that_succeeded_is_compacted(self):
        self.refresh_exiting(lambda timeout=None: 0).assert_called_once_with(self.root)

    def test_a_failed_update_compacts_nothing(self):
        self.refresh_exiting(lambda timeout=None: 1).assert_not_called()

    def test_an_update_that_timed_out_compacts_nothing(self):
        waits = []

        def wait(timeout=None):
            waits.append(timeout)
            if len(waits) == 1:
                raise subprocess.TimeoutExpired("run-index", 1)
            return -9

        self.refresh_exiting(wait).assert_not_called()

    def test_compaction_runs_under_the_roots_lock(self):
        # The worker's lock is what keeps this hook's next refresh off the
        # file while it is rewritten, so the rewrite happens inside it.
        seen = []
        child = mock.Mock(pid=4242)
        child.wait.return_value = 0
        self.build()
        self.hook.mark_pending(self.root, self.root)
        with mock.patch.object(self.hook.subprocess, "Popen", return_value=child), \
                mock.patch.object(self.hook, "compact", side_effect=lambda root: seen.append(
                    self.hook.held(self.root, root))):
            self.hook.work(self.root, self.root)
        self.assertEqual([True], seen)


class TheDetachedWorkerReallyRuns(unittest.TestCase):
    """Copilot, rounds 2 and 4: every case above replaces `spawn` or `refresh`.

    So a regression in the detached launch — its argv, its creation flags, the
    worker's own entry point — would leave the index silently stale with this
    suite green, because the hook discards every stream and always exits 0.
    This case builds a throwaway owner checkout holding copies of the hook and
    its launcher and a stub wrapper that records its arguments, runs the exact
    command `settings.json` registers against a real event, and waits for the
    detached worker to call the wrapper and let go of the lock.
    """

    def test_an_event_reaches_the_wrapper_through_the_detached_worker(self):
        if shutil.which("bash") is None:
            self.fail("bash is required: the hook refreshes nothing without it")
        base = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, base, ignore_errors=True)
        owner = os.path.join(base, "owner")
        os.mkdir(owner)
        git("init", "-q", cwd=owner)
        git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q",
            "--allow-empty", "-m", "root", cwd=owner)
        sibling = os.path.join(base, "owner-feature")
        git("worktree", "add", "-q", "-b", "feature", sibling, cwd=owner)
        # The owner's index, which the detached worker seeds the worktree from.
        write_index(owner)

        hooks = Path(owner, ".claude", "hooks")
        hooks.mkdir(parents=True)
        shutil.copyfile(HOOK, hooks / "index-refresh.py")
        # The launcher too, because the event goes in through the command
        # `settings.json` registers and not through the module: interpreter
        # choice, the launcher's allow-list and its stdin forwarding are all
        # on the path. Copilot, round 4.
        shutil.copyfile(HOOK.parent / "run-guard.sh", hooks / "run-guard.sh")
        scripts = Path(owner, ".claude", "skills", "codebase-index", "scripts")
        scripts.mkdir(parents=True)
        # The wrapper runs with the owner as its working directory, so the
        # record is a fixed relative name and no path is quoted into shell
        # text: a temp directory holding an apostrophe broke that. Raised by
        # Copilot.
        record = Path(owner, "wrapper-ran")
        scripts.joinpath("run-index").write_text(
            "#!/usr/bin/env bash\n"
            "printf '%s\\n' \"$@\" > wrapper-ran\n",
            encoding="utf-8", newline="\n")

        settings = json.loads(SETTINGS.read_text(encoding="utf-8"))
        [command] = [
            h["command"] for entry in settings["hooks"]["PostToolUse"]
            for h in entry.get("hooks", []) if "index-refresh.py" in h.get("command", "")]
        sh = shutil.which("sh")
        if sh is None:
            self.fail("sh is required: the registered command starts with it")
        event = json.dumps({"cwd": sibling, "hook_event_name": "PostToolUse"})
        done = subprocess.run(
            [sh, "-c", command], input=event, text=True, capture_output=True,
            timeout=30, env={**os.environ, "CLAUDE_PROJECT_DIR": owner})
        self.assertEqual(0, done.returncode, done.stderr)

        hook = load()
        deadline = time.time() + 60
        while time.time() < deadline and (not record.exists() or hook.held(owner, sibling)):
            time.sleep(0.5)
        self.assertTrue(record.exists(), "the detached worker never ran the wrapper")
        args = record.read_text(encoding="utf-8").split("\n")
        self.assertEqual(["--quiet", "--root"], args[:2])
        self.assertEqual(real(sibling), real(args[2]))
        self.assertEqual("update", args[3])
        self.assertEqual(["main"], read_index(index_path(sibling)))
        self.assertFalse(hook.held(owner, sibling), "the worker finished without releasing")
        self.assertFalse(os.path.exists(hook.pending_path(owner, sibling)))


class TheRefreshIsWiredThroughTheLauncher(unittest.TestCase):

    COMMAND = ('sh "${CLAUDE_PROJECT_DIR}/.claude/hooks/run-guard.sh" '
               "index-refresh.py")

    def entries_running_this_hook(self):
        """`{event: entries}` for every hook event that runs this hook.

        Every event rather than the one being asked about, because the
        subject is which moves are covered. A read naming `PostToolUse`
        proves that registration and stays green when a second trigger is
        dropped, or when a third is added with no decision behind it — the
        gate-coverage lesson in `CLAUDE.md`, turned on this file's own last
        class.
        """
        settings = json.loads(SETTINGS.read_text(encoding="utf-8"))
        running = {}
        for event, entries in (settings.get("hooks") or {}).items():
            matched = [
                entry for entry in entries
                if any(hook.get("type") == "command"
                       and hook.get("command") == self.COMMAND
                       for hook in entry.get("hooks", []))
            ]
            if matched:
                running[event] = matched
        return running

    def test_the_hook_runs_on_an_edit_and_on_a_session_start(self):
        # `PostToolUse` covers what this session changes. `SessionStart`
        # covers what it opens onto: a merge, a branch switch or a pull
        # rewrites the tree with no tool event behind it, and `/branch` ships
        # every PR from a forked worktree, so this checkout's `main` moves
        # almost entirely by merges nobody edited through.
        self.assertEqual({"PostToolUse", "SessionStart"},
                         set(self.entries_running_this_hook()))

    def test_no_matcher_narrows_the_session_start_entry(self):
        # `startup`, `resume`, `clear` and `compact` each leave the session
        # looking at a tree the index may not have seen. A matcher naming one
        # of them would cover that one and read as covering the event.
        for entry in self.entries_running_this_hook()["SessionStart"]:
            self.assertNotIn("matcher", entry)

    def test_the_edit_entry_also_runs_after_every_bash_call(self):
        # blueprint-frontend#136: commits, pulls, rebases and edit scripts change tracked files
        # through the shell. The four edit tools and Bash, and nothing else.
        [entry] = self.entries_running_this_hook()["PostToolUse"]
        self.assertEqual({"Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"},
                         set(entry["matcher"].split("|")))

    def test_the_launcher_admits_it(self):
        launcher = (SCRIPTS.parent / "hooks" / "run-guard.sh").read_text(
            encoding="utf-8")
        # The `case` line itself, split into its names: the usage line names
        # every hook too, so a pattern over the whole file is satisfied by it.
        [case] = [line for line in launcher.splitlines()
                  if "guard-git-argv.py|" in line and line.rstrip().endswith(") ;;")]
        self.assertIn("index-refresh.py",
                      case.strip().removesuffix(") ;;").split("|"))


if __name__ == "__main__":
    unittest.main()
