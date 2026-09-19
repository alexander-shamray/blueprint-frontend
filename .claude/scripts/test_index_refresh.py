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
import subprocess
import tempfile
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

    def test_an_edit_in_a_sibling_worktree_refreshes_that_worktree(self):
        root = self.hook.target_root(self.sibling, self.main)
        self.assertIsNotNone(root)
        self.assertEqual(real(self.sibling), real(root))

    def test_a_subdirectory_is_walked_up_to_its_checkout(self):
        sub = os.path.join(self.sibling, "src", "app")
        os.makedirs(sub)
        self.assertEqual(real(self.sibling), real(self.hook.target_root(sub, self.main)))

    def test_the_startup_checkout_still_refreshes_itself(self):
        self.assertEqual(real(self.main), real(self.hook.target_root(self.main, self.main)))

    def test_a_sweep_checkout_is_refused(self):
        self.assertIsNone(self.hook.target_root(self.sweep, self.main))

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
        # owner. The spawn is replaced, not the decision.
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
        self.assertTrue(os.path.isfile(self.hook.lock_path(argv[3])))

    def test_the_refresh_runs_the_owners_wrapper_against_the_worktree(self):
        with mock.patch.object(self.hook.subprocess, "run") as run:
            self.hook.refresh(self.main, self.sibling)
        argv = run.call_args.args[0]
        self.assertEqual(real(self.main), real(run.call_args.kwargs["cwd"]))
        self.assertEqual(
            real(os.path.join(self.main, ".claude", "skills", "codebase-index",
                              "scripts", "run-index")),
            real(argv[1]))
        self.assertEqual(["--quiet", "--root", self.sibling], argv[2:5])
        # No index has been built in the new worktree, so this is the build.
        self.assertEqual(["index"], argv[5:])

    def test_a_worktree_with_an_index_is_updated_not_rebuilt(self):
        # `update` against a worktree with no index prints *No index found*
        # and exits, so choosing it unconditionally refreshed nothing in the
        # fresh worktree every `/branch` creates.
        self.assertEqual("index", self.hook.subcommand(self.sibling))
        cache = os.path.join(self.sibling, ".claude", "cache", "codebase-index")
        os.makedirs(cache)
        Path(cache, "index.sqlite").write_bytes(b"")
        self.assertEqual("update", self.hook.subcommand(self.sibling))

    def test_a_refused_root_spawns_nothing(self):
        for payload in (json.dumps({"cwd": self.sweep}), "not json", "[]"):
            with self.subTest(payload=payload), \
                    mock.patch.object(self.hook, "home", return_value=self.main), \
                    mock.patch.object(self.hook, "spawn") as spawn, \
                    mock.patch("sys.stdin", io.StringIO(payload)):
                self.assertEqual(0, self.hook.main([]))
                spawn.assert_not_called()

    def test_the_worker_entry_point_judges_its_root_again(self):
        with mock.patch.object(self.hook, "home", return_value=self.main), \
                mock.patch.object(self.hook, "work") as work:
            self.assertEqual(0, self.hook.main(["--worker", self.sweep]))
        work.assert_not_called()


class OneWorkerPerRootAndNoEditDropped(unittest.TestCase):
    """Copilot, round 1: the index check and the detached launch raced.

    Two edits inside the first build both chose `index`, and later edits ran
    overlapping `update`s against one cache. These cases drive the lock and
    the pending marker directly, with the refresh itself replaced.
    """

    def setUp(self):
        self.hook = load()
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)

    def test_an_edit_during_a_run_leaves_a_marker_and_starts_nothing(self):
        self.assertTrue(self.hook.acquire(self.root))
        with mock.patch.object(self.hook, "spawn") as spawn:
            self.hook.start(self.root, self.root)
        spawn.assert_not_called()
        self.assertTrue(os.path.isfile(self.hook.pending_path(self.root)))

    def test_a_free_lock_is_taken_before_the_worker_starts(self):
        with mock.patch.object(self.hook, "spawn") as spawn:
            self.hook.start(self.root, self.root)
        spawn.assert_called_once()
        self.assertFalse(self.hook.acquire(self.root))

    def test_edits_during_a_run_earn_exactly_one_more_run(self):
        runs = []

        def refresh(owner, root):
            runs.append(root)
            if len(runs) == 1:
                # Three edits arrive while the first run is going.
                for _ in range(3):
                    self.hook.start(owner, root)

        self.assertTrue(self.hook.acquire(self.root))
        with mock.patch.object(self.hook, "refresh", side_effect=refresh), \
                mock.patch.object(self.hook, "spawn") as spawn:
            self.hook.work(self.root, self.root)
        self.assertEqual(2, len(runs))
        spawn.assert_not_called()
        self.assertFalse(os.path.exists(self.hook.lock_path(self.root)))
        self.assertFalse(os.path.exists(self.hook.pending_path(self.root)))

    def test_a_marker_left_as_the_lock_is_released_is_still_served(self):
        # The window the second check closes: an edit that found the lock
        # held, but wrote its marker only after the worker's last look.
        runs = []
        real_release = self.hook.release

        def release(root):
            real_release(root)
            if len(runs) == 1:
                self.hook.mark_pending(root)

        self.assertTrue(self.hook.acquire(self.root))
        with mock.patch.object(self.hook, "refresh",
                               side_effect=lambda o, r: runs.append(r)), \
                mock.patch.object(self.hook, "release", side_effect=release):
            self.hook.work(self.root, self.root)
        self.assertEqual(2, len(runs))
        self.assertFalse(os.path.exists(self.hook.lock_path(self.root)))

    def test_a_crashed_workers_lock_is_taken_over(self):
        self.assertTrue(self.hook.acquire(self.root))
        old = time.time() - self.hook.STALE_AFTER - 5
        os.utime(self.hook.lock_path(self.root), (old, old))
        self.assertTrue(self.hook.acquire(self.root))

    def test_a_live_lock_is_not_taken_over(self):
        self.assertTrue(self.hook.acquire(self.root))
        self.assertFalse(self.hook.acquire(self.root))


class TheRefreshIsWiredThroughTheLauncher(unittest.TestCase):

    def test_the_post_tool_use_entry_runs_this_hook(self):
        settings = json.loads(SETTINGS.read_text(encoding="utf-8"))
        commands = [
            h.get("command", "")
            for entry in settings["hooks"]["PostToolUse"]
            for h in entry.get("hooks", [])
        ]
        self.assertIn(
            'sh "${CLAUDE_PROJECT_DIR}/.claude/hooks/run-guard.sh" index-refresh.py',
            commands)

    def test_the_launcher_admits_it(self):
        launcher = (SCRIPTS.parent / "hooks" / "run-guard.sh").read_text(
            encoding="utf-8")
        self.assertRegex(launcher, r"\|index-refresh\.py\)")


if __name__ == "__main__":
    unittest.main()
