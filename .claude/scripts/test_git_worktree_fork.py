"""git-worktree-fork.sh: the one worktree shape /branch step 5 creates.

The helper is `/branch`'s only route to `git worktree add`, so its refusals
are the boundary and this suite is what watches them: the path must be
`.claude/worktrees/<name>`, git must ignore it, and the fork must run from the
main checkout's root, where that relative path means what `/branch` says.

Ported from `alexander-shamray/blueprint-backend`, where the move into
`.claude/worktrees/` was built and reviewed. The harness is spelled here
rather than imported, for the reason `test_git_rebase_onto_main.py` gives:
each suite in this directory carries its own.

Run: py -3.12 -m unittest discover -s .claude/scripts
Needs bash and git on PATH, and nothing else: every case drives a real
repository.
"""

import os
import shutil
import subprocess
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
FORK = SCRIPTS / "git-worktree-fork.sh"

# The fixtures answer for the script, not for whoever runs them: without this
# the developer's global gitconfig is live inside every fixture repository. A
# path that does not exist reads as an empty config file on every platform.
NO_CONFIG = str(SCRIPTS / "no-such-gitconfig-for-the-fixtures")

BASH = shutil.which("bash")
GIT = shutil.which("git")


def setUpModule():
    # Not a skip. A skip on a missing tool reports a pass, which is the
    # fail-open every gate in this repository is written against.
    missing = [name for name, path in (("bash", BASH), ("git", GIT)) if path is None]
    if missing:
        raise RuntimeError(
            f"{', '.join(missing)} required and not on PATH: these tests exercise "
            "the same tools the script does"
        )


def run_bash(script, **env_extra):
    """Run a bash fragment with every input in the environment.

    Nothing is passed as an argument: under MSYS an argv element crossing into
    `bash.exe` is re-parsed, so a path arrives mangled and the case silently
    tests something else. Environment variables are not re-parsed.
    """
    env = dict(os.environ)
    env.setdefault("GIT_CONFIG_GLOBAL", NO_CONFIG)
    env.setdefault("GIT_CONFIG_SYSTEM", NO_CONFIG)
    # git reads its default excludes file whatever GIT_CONFIG_GLOBAL says, so a
    # developer whose global ignore lists .claude/ would pass the unignored case.
    env.setdefault("GIT_CONFIG_COUNT", "1")
    env.setdefault("GIT_CONFIG_KEY_0", "core.excludesFile")
    env.setdefault("GIT_CONFIG_VALUE_0", "")
    env.update(env_extra)
    return subprocess.run([BASH, "-c", script], capture_output=True,
                          text=True, env=env)


# A repository with an origin/main to fork from, made by bash so the paths are
# the ones the script sees. `IGNORE` decides whether .gitignore names the
# worktree directory, which is the check the ignored/unignored cases turn on.
FIXTURE = """
set -e
root=$(mktemp -d)
git init -q -b main "$root/origin"
git -C "$root/origin" -c user.name=t -c user.email=t@t commit -q --allow-empty -m base
git clone -q "$root/origin" "$root/checkout"
if [ "$IGNORE" = yes ]; then printf '.claude/worktrees/\\n' > "$root/checkout/.gitignore"; fi
mkdir -p "$root/checkout/src"
printf '%s\\n' "$root"
"""


class ForkShape(unittest.TestCase):
    """The helper forks `.claude/worktrees/<name>` from the main checkout only."""

    def fixture(self, ignore="yes"):
        made = run_bash(FIXTURE, IGNORE=ignore)
        self.assertEqual(0, made.returncode, made.stderr)
        root = made.stdout.strip()
        self.addCleanup(lambda: run_bash('rm -rf "$TARGET"', TARGET=root))
        return root

    def fork(self, where, path, branch="feat/probe", **env):
        return run_bash('cd "$WHERE" && bash "$FORK" "$P" "$B"',
                        WHERE=where, FORK=str(FORK), P=path, B=branch, **env)

    def test_the_documented_shape_forks_with_no_upstream(self):
        root = self.fixture()
        checkout = f"{root}/checkout"
        result = self.fork(checkout, ".claude/worktrees/probe")
        self.assertEqual(0, result.returncode, result.stderr)
        head = run_bash('git -C "$W" branch --show-current',
                        W=f"{checkout}/.claude/worktrees/probe")
        self.assertEqual("feat/probe", head.stdout.strip(), head.stderr)
        # `--no-track`: a start point that is a remote-tracking ref would
        # otherwise become the upstream, and /pr would never set the right one.
        upstream = run_bash(
            'git -C "$C" rev-parse --abbrev-ref "feat/probe@{upstream}"',
            C=checkout)
        self.assertNotEqual(0, upstream.returncode, upstream.stdout)
        # The worktree sits inside the checkout, and ignored is what keeps it
        # out of every `git status` the chain reads.
        status = run_bash('git -C "$C" status --porcelain --untracked-files=all',
                          C=checkout)
        self.assertEqual(0, status.returncode, status.stderr)
        self.assertNotIn(".claude", status.stdout)

    def test_any_other_path_is_refused(self):
        root = self.fixture()
        for path in ("../sibling", ".claude/worktrees/../x",
                     ".claude/worktrees/a/b", "/tmp/x", ".claude/worktrees/-f",
                     "./.claude/worktrees/x", ".claude/worktrees/"):
            with self.subTest(path=path):
                result = self.fork(f"{root}/checkout", path)
                self.assertEqual(2, result.returncode, result.stderr)
                self.assertIn("must be .claude/worktrees/<name>", result.stderr)
        branches = run_bash('git -C "$C" branch --list feat/probe',
                            C=f"{root}/checkout")
        self.assertEqual("", branches.stdout.strip())

    def test_an_unignored_path_is_refused(self):
        root = self.fixture(ignore="no")
        result = self.fork(f"{root}/checkout", ".claude/worktrees/probe")
        self.assertEqual(2, result.returncode, result.stderr)
        self.assertIn("is not ignored", result.stderr)
        # Probed through bash: `root` is bash's spelling of the temp directory,
        # which native Windows Python reads as a path that never exists.
        absent = run_bash('[ ! -e "$P" ]',
                          P=f"{root}/checkout/.claude/worktrees/probe")
        self.assertEqual(0, absent.returncode)
        branches = run_bash('git -C "$C" branch --list feat/probe',
                            C=f"{root}/checkout")
        self.assertEqual("", branches.stdout.strip())

    def test_a_subdirectory_is_refused(self):
        root = self.fixture()
        result = self.fork(f"{root}/checkout/src", ".claude/worktrees/probe")
        self.assertEqual(2, result.returncode, result.stderr)
        self.assertIn("checkout root", result.stderr)

    def test_a_linked_worktree_is_refused(self):
        root = self.fixture()
        first = self.fork(f"{root}/checkout", ".claude/worktrees/first",
                          "feat/first")
        self.assertEqual(0, first.returncode, first.stderr)
        # From inside the first worktree the same relative path would nest a
        # second one in it, which /branch step 0 refuses.
        inner = f"{root}/checkout/.claude/worktrees/first"
        result = self.fork(inner, ".claude/worktrees/second", "feat/second")
        self.assertEqual(2, result.returncode, result.stderr)
        self.assertIn("not a linked worktree", result.stderr)

    def test_an_existing_branch_is_refused_rather_than_reset(self):
        root = self.fixture()
        made = run_bash('git -C "$C" branch feat/probe', C=f"{root}/checkout")
        self.assertEqual(0, made.returncode, made.stderr)
        result = self.fork(f"{root}/checkout", ".claude/worktrees/probe")
        self.assertEqual(3, result.returncode, result.stderr)
        self.assertIn("branch already exists", result.stderr)

    def test_outside_a_repository_says_so(self):
        made = run_bash('mktemp -d')
        self.assertEqual(0, made.returncode, made.stderr)
        outside = made.stdout.strip()
        self.addCleanup(lambda: run_bash('rm -rf "$TARGET"', TARGET=outside))
        # The temp root may itself sit inside some checkout; the ceiling keeps
        # git's discovery from walking up into it.
        ceiling = run_bash('cd "$D/.." && pwd -W 2>/dev/null || pwd', D=outside)
        result = self.fork(outside, ".claude/worktrees/probe",
                           GIT_CEILING_DIRECTORIES=ceiling.stdout.strip())
        self.assertEqual(2, result.returncode, result.stderr)
        self.assertIn("not in a git repository", result.stderr)


if __name__ == "__main__":
    unittest.main()
