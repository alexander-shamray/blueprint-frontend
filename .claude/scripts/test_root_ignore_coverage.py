"""Every directory that ignores itself must be ignored at the root as well.

**The subject is the disagreement between git and the code index, not either
one of them.** Git honours a `.gitignore` at any depth, so a directory holding
one that says `*` vanishes from `git status` and from `git ls-files` — which is
why `.remember/` and `.superpowers/sdd/` have looked correctly excluded in this
repository since they arrived. The indexer reads only the root ignore files its
config names, so the same nested file is invisible to it: #53 measured 647 of
987 indexed files as session state, two thirds of the index, with session logs
carrying PR comments and sweep reads coming back ranked beside code as
`recommended_reads`.

Neither tool can see that the other disagrees, which is what makes this a shape
to gate rather than a fix to make once. The root rules added for #53 close the
two directories that exist today; the cases here assert the *rule*, so the next
tool that drops a self-ignoring directory into the checkout cannot reopen it.

**`TheScannerSeesTheShape` is the load-bearing class and the live scan is
not.** A fresh CI checkout holds neither `.remember/` nor `.superpowers/` —
both are local session state — so `EveryBlanketIgnoreIsCoveredAtTheRoot` runs
over an empty listing on the machine where this suite actually gates, and would
go on passing if the scanner stopped working entirely. Its subject is therefore
what the gate is looking at, built in a temp tree: `CLAUDE.md`'s rule about
gates, applied to this one.
"""

import shutil
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent.parent

# The ignore files `codebase-index` reads AT THE ROOT, from the `ignore_files`
# list in its config. That config lives under `.claude/cache/`, which is
# gitignored and absent from a CI checkout, so the names cannot be read from it
# here — this is a citation of the indexer's default rather than a second owner
# of it, and a name added upstream wants adding here too.
ROOT_IGNORE_NAMES = (
    ".gitignore",
    ".cursorignore",
    ".claudeignore",
    ".codeindexignore",
)


def significant(path):
    """An ignore file's rules, without its blank lines and its comments."""
    return [
        line.strip()
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]


def root_rules(root):
    """Every rule in every root ignore file that exists under `root`."""
    rules = set()
    for name in ROOT_IGNORE_NAMES:
        path = Path(root, name)
        if path.is_file():
            rules.update(significant(path))
    return rules


def covered(relative, rules):
    """Is this directory taken whole by a root rule?

    `relative` is posix-spelled and relative to the checkout root, and a rule
    covers it when it names the directory or any ancestor of it in one of the
    four plain spellings git accepts for a directory prefix.

    **Only plain prefixes are recognised, and that is the decision rather than
    the limitation.** A glob that happens to cover the directory reads as
    uncovered here, so the gate fails closed and the fix is to add the plain
    rule `blueprint-backend` and `blueprint-admin` already use. Teaching this
    matcher the rest of gitignore would put a second, worse copy of git's
    semantics in a test file, which is the copy that goes stale.
    """
    parts = [part for part in relative.split("/") if part]
    for depth in range(1, len(parts) + 1):
        prefix = "/".join(parts[:depth])
        for spelling in (prefix, prefix + "/", "/" + prefix, "/" + prefix + "/"):
            if spelling in rules:
                return True
    return False


def blanket(directory):
    """Does this directory hold a nested `.gitignore` that takes all of it?

    `*` with no negation. A file that excepts something (`!keep-me`) leaves
    part of the directory visible to git, so the two tools do not disagree
    about it and it is not this file's subject.

    **`.gitignore` alone, of the four names above.** Git is the only reader
    that honours an ignore file at depth; a nested `.codeindexignore` is read
    by nothing at all, so it hides the directory from nobody and creates no
    disagreement to gate.
    """
    path = directory / ".gitignore"
    if not path.is_file():
        return False
    rules = significant(path)
    return "*" in rules and not any(rule.startswith("!") for rule in rules)


def self_ignoring(root, rules):
    """Every directory under `root` holding a blanket nested `.gitignore`.

    A directory a root rule already takes is not descended into: everything
    beneath it is covered by construction, and `node_modules/` alone would
    otherwise dominate the walk. A blanket directory is recorded and not
    descended into either — it is the answer, and what sits inside it cannot
    change that.
    """
    found = []

    def walk(relative):
        base = Path(root, relative) if relative else Path(root)
        try:
            entries = sorted(base.iterdir())
        except OSError:
            return
        for entry in entries:
            if entry.name == ".git" or entry.is_symlink() or not entry.is_dir():
                continue
            child = f"{relative}/{entry.name}" if relative else entry.name
            if blanket(entry):
                found.append(child)
            elif not covered(child, rules):
                walk(child)

    walk("")
    return found


class TheScannerSeesTheShape(unittest.TestCase):
    """The gate's real subject, because the live scan below is empty in CI."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, str(self.root), ignore_errors=True)

    def write(self, relative, text):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8", newline="\n")

    def test_a_blanket_nested_ignore_is_found(self):
        self.write("state/.gitignore", "*\n")
        self.assertEqual(["state"], self_ignoring(self.root, set()))

    def test_it_is_found_below_the_top_level(self):
        # `.superpowers/sdd/` is this shape: the blanket file sits one level
        # down, and the directory above it holds nothing else at all.
        self.write("tools/sdd/.gitignore", "*\n")
        self.assertEqual(["tools/sdd"], self_ignoring(self.root, set()))

    def test_an_ordinary_nested_ignore_is_not_a_blanket(self):
        self.write("src/.gitignore", "build/\n*.log\n")
        self.assertEqual([], self_ignoring(self.root, set()))

    def test_a_negation_leaves_the_directory_visible_to_git(self):
        self.write("state/.gitignore", "*\n!keep-me\n")
        self.assertEqual([], self_ignoring(self.root, set()))

    def test_comments_and_blanks_are_not_rules(self):
        self.write("state/.gitignore", "\n# everything\n*\n\n")
        self.assertEqual(["state"], self_ignoring(self.root, set()))

    def test_a_covered_directory_is_still_reported(self):
        # Reported, because the assertion below needs a subject to pass ON —
        # a scanner that dropped covered directories would make the live case
        # vacuous a second way. Not descended into, because everything under
        # it is covered by construction.
        self.write("state/.gitignore", "*\n")
        self.write("state/inner/.gitignore", "*\n")
        self.assertEqual(["state"], self_ignoring(self.root, {"state/"}))

    def test_a_covered_tree_is_not_walked(self):
        self.write("vendor/pkg/.gitignore", "*\n")
        self.assertEqual([], self_ignoring(self.root, {"vendor/"}))
        # And the same tree with nothing covering it, so the case above is
        # about the rule rather than about the scanner failing to look.
        self.assertEqual(["vendor/pkg"], self_ignoring(self.root, set()))

    def test_the_git_directory_is_never_walked(self):
        self.write(".git/modules/thing/.gitignore", "*\n")
        self.assertEqual([], self_ignoring(self.root, set()))


class TheMatcherReadsTheSpellingsGitAccepts(unittest.TestCase):

    def test_each_plain_directory_spelling_covers(self):
        for rule in (".remember", ".remember/", "/.remember", "/.remember/"):
            with self.subTest(rule=rule):
                self.assertTrue(covered(".remember", {rule}))

    def test_an_ancestor_covers_what_sits_under_it(self):
        self.assertTrue(covered(".superpowers/sdd", {".superpowers/"}))

    def test_a_descendant_does_not_cover_its_parent(self):
        self.assertFalse(covered(".superpowers", {".superpowers/sdd/"}))

    def test_an_unrelated_rule_does_not_cover(self):
        self.assertFalse(covered(".remember", {"node_modules/", "/dist"}))

    def test_a_glob_reads_as_uncovered(self):
        # Failing closed, per `covered`'s docstring: the fix for a directory
        # this reports is a plain rule, never a cleverer matcher here.
        self.assertFalse(covered(".remember", {".rem*/"}))


class EveryBlanketIgnoreIsCoveredAtTheRoot(unittest.TestCase):
    """The live scan over this checkout — empty in CI, by construction."""

    def test_the_root_ignore_files_are_readable(self):
        # The positive control this class can hold on a CI checkout: the root
        # ignore files are tracked, so their rules are there whether or not
        # any session state is.
        rules = root_rules(ROOT)
        self.assertGreater(len(rules), 10)
        self.assertIn("__pycache__/", rules)

    def test_nothing_hides_from_git_and_not_from_the_index(self):
        rules = root_rules(ROOT)
        uncovered = [
            directory for directory in self_ignoring(ROOT, rules)
            if not covered(directory, rules)
        ]
        self.assertEqual(
            [], uncovered,
            "each of these holds a .gitignore of `*`, so git ignores it and "
            "the code index does not. Add it to the root .gitignore (#53).",
        )


class TheSessionStateTreesAreIgnoredAtTheRoot(unittest.TestCase):
    """#53's own regression lock, and the half that holds on a CI checkout.

    The class above cannot assert this. `.remember/` and `.superpowers/` are
    local session state, so a checkout without them scans clean whether or not
    the root rules survived — these two read the tracked file instead.
    """

    def test_remember_is_covered(self):
        self.assertTrue(covered(".remember", root_rules(ROOT)))

    def test_superpowers_is_covered(self):
        # Spelled at the depth the blanket file actually sits at, so the
        # ancestor rule is what has to answer for it.
        self.assertTrue(covered(".superpowers/sdd", root_rules(ROOT)))


if __name__ == "__main__":
    unittest.main()
