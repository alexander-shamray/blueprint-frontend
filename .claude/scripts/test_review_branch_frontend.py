"""`/review-branch`'s editing boundary, held against this checkout's own tree.

`docs/harness-local.md` *Residuals* argues it. Needs git on PATH.
Run: py -3.12 -m unittest discover -s .claude/scripts -p 'test_review_branch_frontend.py'
"""

import re
import shutil
import subprocess
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
COMMANDS = SCRIPTS.parent / "commands"
ROOT = SCRIPTS.parent.parent
GIT = shutil.which("git")
COMMAND = "review-branch.md"


def setUpModule():
    # Not a skip: a skip on a missing tool reports a pass (docs/testing.md).
    if not GIT:
        raise RuntimeError("the review-branch cases need git on PATH")


def tracked():
    out = subprocess.run([GIT, "ls-files"], cwd=str(ROOT), capture_output=True, text=True)
    if out.returncode != 0:
        raise AssertionError(f"git ls-files failed: {out.stderr}")
    return [line for line in out.stdout.splitlines() if line]


def tracked_trees():
    """Every top-level directory git tracks, read from git rather than listed."""
    return {line.split("/")[0] for line in tracked() if "/" in line}


def tracked_root_files():
    return {line for line in tracked() if "/" not in line}


def disallowed():
    text = (COMMANDS / COMMAND).read_text(encoding="utf-8")
    found = re.findall(r"^disallowed-tools:\s*(.+)$", text, re.MULTILINE)
    if len(found) != 1:
        raise AssertionError(f"expected one disallowed-tools line in {COMMAND}, found {len(found)}")
    return [entry.strip() for entry in found[0].split(",")]


class ReviewBranchDeniesEveryTrackedPath(unittest.TestCase):
    # Every name the Node toolchain reads without being asked. Several are not
    # data: `eslint.config.*`, `vite*.config.*` and `prettier.config.*` are
    # JavaScript executed in order to be loaded, and `.npmrc` can set
    # `script-shell`. That makes the list a security boundary.
    AUTO_IMPORTED = (
        ".npmrc", "npm-shrinkwrap.json",
        "vitest.config.ts", "vitest.config.js", "vitest.config.mts",
        "vite.config.ts", "vite.config.js", "vite.config.mts",
        "eslint.config.mjs", "eslint.config.cjs",
        "prettier.config.js", "prettier.config.cjs", "prettier.config.mjs",
        ".prettierrc.js", ".prettierrc.cjs", ".prettierrc.json",
        "karma.conf.js", "jest.config.js",
    )

    def test_the_tree_listing_is_not_vacuous(self):
        # The positive control for every case below: a listing that silently
        # came back empty would satisfy all of them.
        trees = tracked_trees()
        self.assertGreater(len(trees), 4)
        for expected in ("src", "e2e", "docs", ".github", ".harness"):
            self.assertIn(expected, trees)

    def test_every_tracked_tree_is_denied_in_both_spellings(self):
        # Every tree that exists, so adding one is a red build rather than a
        # quiet widening.
        rules = disallowed()
        for tree in tracked_trees():
            for prefix in ("", "./"):
                with self.subTest(tree=tree, prefix=prefix):
                    self.assertIn(f"Edit({prefix}{tree}/**)", rules)

    def test_the_rules_are_edit_and_never_write(self):
        # File permissions are checked against `Edit(path)` and `Read(path)`
        # only; a `Write(path)` entry is accepted and never consulted.
        for rule in disallowed():
            with self.subTest(rule=rule):
                self.assertFalse(rule.startswith("Write("),
                                 "a Write(path) rule is never consulted; use Edit(path)")

    def test_the_root_file_listing_is_not_vacuous(self):
        files = tracked_root_files()
        self.assertGreater(len(files), 4)
        for expected in ("package.json", "angular.json", "tsconfig.json"):
            self.assertIn(expected, files)

    def test_every_tracked_root_file_is_denied_in_both_spellings(self):
        # Denying directories left every root file writable: `CLAUDE.md`,
        # `package.json`, `angular.json` and `tsconfig.json` all sit at the
        # root, which is where this repository keeps its build inputs.
        rules = disallowed()
        for path in tracked_root_files():
            for prefix in ("", "./"):
                with self.subTest(path=path, prefix=prefix):
                    self.assertIn(f"Edit({prefix}{path})", rules)

    def test_the_auto_load_surface_is_denied(self):
        # The tracked enumeration could never cover this: it reads what exists,
        # and the dangerous file is one that does not. The command holds
        # `Write` and the check runner at once, so a root file no enumeration
        # contains, then the build, would be host code execution.
        rules = disallowed()
        for target in self.AUTO_IMPORTED:
            with self.subTest(target=target):
                self.assertIn(f"Edit({target})", rules)
                self.assertIn(f"Edit(./{target})", rules)

    def test_the_auto_imported_names_are_not_all_tracked(self):
        # The positive control for the case above: at least one auto-imported
        # name is absent, so a test built on `git ls-files` cannot reach it.
        tracked_now = tracked_root_files()
        self.assertIn(".npmrc", [n for n in self.AUTO_IMPORTED if n not in tracked_now])

    def test_the_users_memory_and_output_styles_are_denied(self):
        # Both sit outside the checkout, so no listing of its tree could reach them.
        rules = disallowed()
        for target in ("~/.claude/projects/**", "~/.claude/output-styles/**"):
            with self.subTest(target=target):
                self.assertIn(f"Edit({target})", rules)

    def test_gits_own_control_directory_is_denied(self):
        # `.git` is absent from `git ls-files`, so the coverage case cannot
        # reach it; with an unrestricted `Edit` a command could set
        # `diff.external` in `.git/config` and run code from its own approved
        # `git diff`. A tree and a file, since in a worktree `.git` is a file.
        rules = disallowed()
        for target in (".git/**", "./.git/**", ".git", "./.git"):
            with self.subTest(target=target):
                self.assertIn(f"Edit({target})", rules)

    def test_the_git_directory_is_not_tracked(self):
        self.assertNotIn(".git", tracked_root_files())
        self.assertNotIn(".git", tracked_trees())

    def test_the_repository_tracks_no_symbolic_link(self):
        # A path deny is held by spelling, and a tracked symbolic link inside
        # an allowed tree is a spelling the deny never sees. Defence in depth
        # beside the edit guard, which refuses a link at edit time.
        out = subprocess.run([GIT, "ls-files", "-s"], cwd=str(ROOT), capture_output=True, text=True)
        if out.returncode != 0:
            raise AssertionError(f"git ls-files failed: {out.stderr}")
        entries = out.stdout.splitlines()
        self.assertGreater(len(entries), 100, "git ls-files -s returned almost nothing")
        self.assertEqual([], [e for e in entries if e.startswith("120000 ")])


if __name__ == "__main__":
    unittest.main()
