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
import sys
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
        token = "0" * 32
        for argv in (["--worker", self.sweep, token],
                     ["--worker", self.sibling, "not-a-token"],
                     ["--worker", self.sibling]):
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
        self.assertFalse(self.hook.registered(linked, self.main))
        self.assertTrue(self.hook.registered(self.main, self.main))


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

        token = self.hook.acquire(self.root)
        self.assertIsNotNone(token)
        with mock.patch.object(self.hook, "refresh", side_effect=refresh), \
                mock.patch.object(self.hook, "spawn") as spawn:
            self.hook.work(self.root, self.root, token)
        self.assertEqual(2, len(runs))
        spawn.assert_not_called()
        self.assertFalse(os.path.exists(self.hook.lock_path(self.root)))
        self.assertFalse(os.path.exists(self.hook.pending_path(self.root)))

    def test_a_marker_left_as_the_lock_is_released_is_still_served(self):
        # The window the second check closes: an edit that found the lock
        # held, but wrote its marker only after the worker's last look.
        runs = []
        real_release = self.hook.release

        def release(root, token):
            real_release(root, token)
            if len(runs) == 1:
                self.hook.mark_pending(root)

        token = self.hook.acquire(self.root)
        with mock.patch.object(self.hook, "refresh",
                               side_effect=lambda o, r: runs.append(r)), \
                mock.patch.object(self.hook, "release", side_effect=release):
            self.hook.work(self.root, self.root, token)
        self.assertEqual(2, len(runs))
        self.assertFalse(os.path.exists(self.hook.lock_path(self.root)))

    def test_a_crashed_workers_lock_is_taken_over(self):
        self.assertIsNotNone(self.hook.acquire(self.root))
        old = time.time() - self.hook.STALE_AFTER - 5
        os.utime(self.hook.lock_path(self.root), (old, old))
        self.assertIsNotNone(self.hook.acquire(self.root))

    def test_a_live_lock_is_not_taken_over(self):
        self.assertIsNotNone(self.hook.acquire(self.root))
        self.assertIsNone(self.hook.acquire(self.root))

    def test_a_worker_outliving_the_stale_age_keeps_its_lock(self):
        # Copilot, round 2: the lock's age ran from creation, so a worker
        # serving coalesced runs looked abandoned mid-run. Each run here ages
        # the lock past STALE_AFTER first; the renewal before the next run
        # must keep a second worker out.
        token = self.hook.acquire(self.root)
        taken = []

        def refresh(owner, root):
            if taken:
                # The second run: a takeover attempted now must fail, which it
                # does only if the worker renewed the lock the first run aged.
                taken.append(self.hook.acquire(root))
                return
            # The first run ends long: the lock is older than STALE_AFTER.
            old = time.time() - self.hook.STALE_AFTER - 5
            os.utime(self.hook.lock_path(root), (old, old))
            self.hook.mark_pending(root)
            taken.append("edit")

        with mock.patch.object(self.hook, "refresh", side_effect=refresh):
            self.hook.work(self.root, self.root, token)
        self.assertEqual(["edit", None], taken)
        self.assertFalse(os.path.exists(self.hook.lock_path(self.root)))

    def test_a_worker_never_removes_a_lock_it_no_longer_holds(self):
        token = self.hook.acquire(self.root)
        old = time.time() - self.hook.STALE_AFTER - 5
        os.utime(self.hook.lock_path(self.root), (old, old))
        replacement = self.hook.acquire(self.root)
        self.assertIsNotNone(replacement)
        self.hook.release(self.root, token)
        self.assertTrue(self.hook.holds(self.root, replacement))
        # And the displaced worker stops rather than running beside it.
        with mock.patch.object(self.hook, "refresh") as refresh:
            self.hook.work(self.root, self.root, token)
        refresh.assert_not_called()


class TheDetachedWorkerReallyRuns(unittest.TestCase):
    """Copilot, round 2: every case above replaces `spawn` or `refresh`.

    So a regression in the detached launch — its argv, its creation flags, the
    worker's own entry point — would leave the index silently stale with this
    suite green, because the hook discards every stream and always exits 0.
    This case builds a throwaway owner checkout holding a copy of the hook and
    a stub wrapper that records its arguments, feeds the hook a real event, and
    waits for the detached worker to call the wrapper and let go of the lock.
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

        hooks = Path(owner, ".claude", "hooks")
        hooks.mkdir(parents=True)
        shutil.copyfile(HOOK, hooks / "index-refresh.py")
        scripts = Path(owner, ".claude", "skills", "codebase-index", "scripts")
        scripts.mkdir(parents=True)
        record = Path(base, "wrapper-ran")
        scripts.joinpath("run-index").write_text(
            "#!/usr/bin/env bash\n"
            f"printf '%s\\n' \"$@\" > '{record.as_posix()}'\n",
            encoding="utf-8", newline="\n")

        event = json.dumps({"cwd": sibling, "hook_event_name": "PostToolUse"})
        done = subprocess.run(
            [sys.executable, str(hooks / "index-refresh.py")],
            input=event, text=True, capture_output=True, timeout=30)
        self.assertEqual(0, done.returncode, done.stderr)

        lock = Path(sibling, ".claude", "cache", "codebase-index", "refresh.lock")
        deadline = time.time() + 60
        while time.time() < deadline and (not record.exists() or lock.exists()):
            time.sleep(0.5)
        self.assertTrue(record.exists(), "the detached worker never ran the wrapper")
        args = record.read_text(encoding="utf-8").split("\n")
        self.assertEqual(["--quiet", "--root"], args[:2])
        self.assertEqual(real(sibling), real(args[2]))
        self.assertEqual("index", args[3])
        self.assertFalse(lock.exists(), "the worker finished without releasing")


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
