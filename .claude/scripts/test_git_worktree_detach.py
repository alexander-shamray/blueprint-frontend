"""git-worktree-detach.sh: a sweep's start drops what an interrupted sweep left.

blueprint-frontend#356, ported from blueprint-backend's suite of the same name;
the helper's argument and shape cases stay in `test_harness_helpers.py`'s
`SweepWorktreeShape`. The harness is spelled here rather than imported, for the
reason `test_git_rebase_onto_main.py` gives: each suite in this directory
carries its own.

Run: py -3.12 -m unittest discover -s .claude/scripts
Needs bash and git on PATH, and nothing else: every case drives a real
repository of its own, so the drop can reach nothing of this checkout's.
"""

import os
import shutil
import subprocess
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
DETACH = SCRIPTS / "git-worktree-detach.sh"

# A path that does not exist reads as an empty config file on every platform,
# so the developer's own gitconfig is not live inside a fixture.
NO_CONFIG = str(SCRIPTS / "no-such-gitconfig-for-the-fixtures")

BASH = shutil.which("bash")
GIT = shutil.which("git")


def setUpModule():
    # Not a skip: a skip on a missing tool reports a pass, which is the
    # fail-open every gate in this repository is written against.
    missing = [name for name, path in (("bash", BASH), ("git", GIT)) if path is None]
    if missing:
        raise RuntimeError(f"{', '.join(missing)} required and not on PATH")


def run_bash(script, **env_extra):
    """Run a bash fragment. Everything variable travels in the environment:
    under MSYS an argv element crossing into `bash.exe` is re-parsed, so a path
    arrives mangled and the case silently tests something else.
    """
    env = dict(os.environ)
    env.setdefault("GIT_CONFIG_GLOBAL", NO_CONFIG)
    env.setdefault("GIT_CONFIG_SYSTEM", NO_CONFIG)
    env.update(env_extra)
    return subprocess.run([BASH, "-c", script], capture_output=True, text=True, env=env)


class StaleSweepWorktrees(unittest.TestCase):
    """A sweep's start drops the sweep worktrees interrupted sweeps left.

    A repository and a temp root of their own, made by bash so both sides of
    MSYS see one directory, and no sweep another session is running is in reach.
    """

    def setUp(self):
        made = run_bash(
            'top=$(mktemp -d) && mkdir "$top/root" "$top/repo" && cd "$top/repo"'
            " && git init -q --initial-branch=main ."
            " && git -c user.name=t -c user.email=t@example.invalid commit -q --allow-empty -m t"
            ' && echo "$top"'
        )
        self.assertEqual(0, made.returncode, made.stderr)
        top = made.stdout.strip()
        self.addCleanup(self.remove, top)
        self.top, self.repo, self.root = top, f"{top}/repo", f"{top}/root"

    def remove(self, top):
        # Checked rather than discarded: a cleanup that hides its refusal is
        # how a fixture's repository stays behind unseen.
        gone = run_bash('rm -rf "$TOP"', TOP=top)
        self.assertEqual(0, gone.returncode, gone.stderr)

    def detach(self):
        return run_bash(
            'cd "$R" && bash "$DETACH" "$(git rev-parse HEAD)"',
            R=self.repo, DETACH=str(DETACH), TMPDIR=self.root,
        )

    def made(self):
        result = self.detach()
        self.assertEqual(0, result.returncode, result.stderr)
        return result.stdout.strip()

    def age(self, path):
        # `-t`, which GNU and BSD touch both take; macOS has no `-d "2 days ago"`.
        aged = run_bash('touch -t 202001010000 "$P"', P=path)
        self.assertEqual(0, aged.returncode, aged.stderr)

    def names(self):
        listing = run_bash('cd "$R" && git worktree list --porcelain', R=self.repo)
        self.assertEqual(0, listing.returncode, listing.stderr)
        return {line.rsplit("/", 1)[-1] for line in listing.stdout.splitlines()
                if line.startswith("worktree ")}

    def test_a_day_old_sweep_worktree_goes_and_a_fresh_one_stays(self):
        old, fresh = self.made(), self.made()
        self.age(old)
        result = self.detach()
        self.assertEqual(0, result.returncode, result.stderr)
        new = result.stdout.strip()
        self.assertEqual(1, len(result.stdout.splitlines()), "stdout is still the path alone")
        names = self.names()
        self.assertNotIn(old.rsplit("/", 1)[-1], names)
        self.assertIn(fresh.rsplit("/", 1)[-1], names)
        self.assertIn(new.rsplit("/", 1)[-1], names)
        self.assertEqual("gone", run_bash('[ -e "$P" ] || echo gone', P=old).stdout.strip())

    def test_a_day_old_worktree_of_another_shape_is_never_a_candidate(self):
        # The candidates are sweep-shaped by name; a PR worktree is as old as
        # its pull request, and the age alone must never reach it. The drop
        # helper would refuse this path too, so the subject is that it is
        # never handed over: a handed one is named on stderr as left standing.
        other = f"{self.top}/feature"
        added = run_bash('cd "$R" && git worktree add -q --detach "$P" HEAD', R=self.repo, P=other)
        self.assertEqual(0, added.returncode, added.stderr)
        self.age(other)
        result = self.detach()
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertNotIn("left a stale sweep worktree standing", result.stderr)
        self.assertIn("feature", self.names())

    def test_a_stale_worktree_holding_a_file_is_left_standing_and_named(self):
        # git's refusal to remove a tree holding anything modified or untracked
        # is the guard, and a teardown it refused leaves the tree for inspection.
        old = self.made()
        self.assertEqual(0, run_bash('echo x > "$P/kept.txt"', P=old).returncode)
        self.age(old)
        result = self.detach()
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("left a stale sweep worktree standing", result.stderr)
        self.assertIn(old.rsplit("/", 1)[-1], self.names())

    def test_a_registration_whose_directory_went_is_pruned(self):
        old = self.made()
        self.assertEqual(0, run_bash('rm -rf "$P"', P=old).returncode)
        self.made()
        self.assertNotIn(old.rsplit("/", 1)[-1], self.names())

    def test_a_refused_commit_drops_nothing(self):
        # Every refusal comes before the drop, so a call refused for its
        # argument changes no worktree.
        old = self.made()
        self.age(old)
        refused = run_bash(
            'cd "$R" && bash "$DETACH" "$SHA"',
            R=self.repo, DETACH=str(DETACH), TMPDIR=self.root, SHA="0" * 40,
        )
        self.assertEqual(3, refused.returncode, refused.stderr)
        self.assertIn(old.rsplit("/", 1)[-1], self.names())


if __name__ == "__main__":
    unittest.main()
