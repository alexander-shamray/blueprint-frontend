"""Every directory that ignores itself must be ignored at the root as well.

**The subject is the disagreement between git and the code index, not either
one of them.** Git honours a `.gitignore` at any depth, so a directory holding
one that says `*` vanishes from `git status` and from `git ls-files` — which is
why `.remember/` and `.superpowers/sdd/` have looked correctly excluded in this
repository since they arrived. The indexer reads only the root ignore files its
config names, so the same nested file is invisible to it and both trees were
indexed whole — session logs included, which is how text from PR comments,
reviews and sweeps came back ranked beside code as `recommended_reads`.
blueprint-frontend#53 owns the measurement, and it moves with the checkout,
so it is cited here rather than copied.

**Every issue number in this file names the frontend repository and says so.**
`CLAUDE.md` reads a bare `#NN` under `.claude/` as an issue in the *backend*,
where this machinery was built, so an unqualified `#53` here points a reader
at the wrong tracker. `blueprint-frontend#45` is the spelling already used in
`guard-edit-target.py` and `test_edit_target_guard.py`. Raised by Copilot,
round 3.

Neither tool can see that the other disagrees, which is what makes this a shape
to gate rather than a fix to make once. The root rules added for that issue
close the two directories that exist today; the cases here assert the *rule*,
so the next tool that drops a self-ignoring directory into the checkout cannot
reopen it.

**`TheScannerSeesTheShape` is the load-bearing class and the live scan is
not.** A fresh CI checkout holds neither `.remember/` nor `.superpowers/` —
both are local session state — so `EveryBlanketIgnoreIsCoveredAtTheRoot` runs
over an empty listing on the machine where this suite actually gates, and would
go on passing if the scanner stopped working entirely. Its subject is therefore
what the gate is looking at, built in a temp tree: `CLAUDE.md`'s rule about
gates, applied to this one.

**Order is read, not discarded, and that is the whole of what the matcher
owes gitignore.** The last rule that matches decides, so `.remember/` followed
by `!.remember/` is not coverage at all — and a matcher collapsing the rules
into a set would call it coverage, which is this gate failing open on the one
edit most likely to undo it. Raised by Copilot, round 1.

**Where this reads git, it reads git rather than remembering it.** Leading
whitespace being part of a pattern, trailing whitespace not being, a negation
under an excluded parent re-including nothing, and a later positive rule
re-excluding a negated name are each measured with `git check-ignore` in this
repository, and the case that pins each one says so. Copilot raised all four
in round 2, and every one turned out to fail open — the parser said covered,
or the scanner said not-a-blanket, where git said otherwise.
"""

import shutil
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent.parent

# The ignore files `codebase-index` reads AT THE ROOT, from the `ignore_files`
# list in its config, in that list's order. That config lives under
# `.claude/cache/`, which is gitignored and absent from a CI checkout, so the
# names cannot be read from it here — this is a citation of the indexer's
# default rather than a second owner of it, and a name added upstream wants
# adding here too.
ROOT_IGNORE_NAMES = (
    ".gitignore",
    ".cursorignore",
    ".claudeignore",
    ".codeindexignore",
)

# The characters that make a pattern a glob. `decides` declines to guess about
# any pattern carrying one.
GLOB = frozenset("*?[")


def significant(path):
    """An ignore file's rules, without its blank lines and its comments.

    **Only trailing whitespace goes, because only trailing whitespace is
    git's to drop.** Measured here with `git check-ignore`: `z.txt ` ignores
    `z.txt`, and ` x.txt` does *not* ignore `x.txt` — the leading space is
    part of the pattern. A `.strip()` normalised an indented rule into an
    effective one, so a root file whose rule excluded nothing read as
    coverage. Raised by Copilot, round 2.
    """
    return [
        line.rstrip()
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.rstrip() and not line.rstrip().startswith("#")
    ]


def parse(lines):
    """Ordered `(negated, pattern)` pairs from ignore-file lines.

    A list rather than a set, because gitignore's semantics *are* the order:
    the last rule that matches a path decides it. `\\!` as an escape for a
    literal leading `!` is not handled and no ignore file here uses one.
    """
    return [
        (line.startswith("!"), line[1:] if line.startswith("!") else line)
        for line in lines
    ]


def root_rules(root):
    """Every rule in every root ignore file that exists, in order."""
    rules = []
    for name in ROOT_IGNORE_NAMES:
        path = Path(root, name)
        if path.is_file():
            rules.extend(parse(significant(path)))
    return rules


def decides(pattern, relative):
    """Whether `pattern` decides `relative`, as one of three answers.

    `True` — it names the directory or an ancestor of it. `False` — it names
    neither. `None` — it carries glob metacharacters, and this matcher will
    not guess; `covered` takes that as the reason to fail closed.

    A pattern holding a slash anywhere but its end is anchored to the root, as
    git anchors it; one without is a component match at any depth, which is
    what makes `__pycache__/` cover `src/__pycache__`.
    """
    if GLOB & set(pattern):
        return None
    body = pattern.strip("/")
    if not body:
        return False
    anchored = pattern.startswith("/") or "/" in body
    parts = [part for part in relative.split("/") if part]
    if not anchored:
        return body in parts
    return body in {"/".join(parts[:depth]) for depth in range(1, len(parts) + 1)}


def covered(relative, rules):
    """Is this directory taken whole by the root rules, read in order?

    `relative` is posix-spelled and relative to the checkout root. The last
    rule that matches it or an ancestor decides, exactly as git decides, so a
    negation placed after a positive rule uncovers the directory and one
    placed before it does not.

    **Only plain patterns are read, and that is the decision rather than the
    limitation.** A positive glob that happens to cover the directory reads as
    no coverage, and a negative one is taken at its word — both directions
    leave the gate red, and the answer is to add the plain rule
    `blueprint-backend` and `blueprint-admin` already use. Teaching this
    matcher the rest of gitignore would put a second, worse copy of git's
    semantics in a test file, which is the copy that goes stale.
    """
    verdict = False
    for negated, pattern in rules:
        answer = decides(pattern, relative)
        if answer is None:
            # A glob. Positive, it cannot establish coverage; negative, it
            # might destroy it, and an unreadable negation is not a reason to
            # assume the best.
            if negated:
                verdict = False
            continue
        if answer:
            verdict = not negated
    return verdict


def blanket(directory):
    """Does this directory hold a nested `.gitignore` that takes all of it?

    Order again: the last matching rule wins, so a negation *before* the `*`
    is overridden by it and only one *after* it can re-admit anything.

    **Biased towards yes, and the asymmetry is the point.** A false yes costs
    a red gate demanding a root rule that was not needed. A false no means a
    self-ignoring directory is never reported, so the gate never asks about it
    at all — which is the fail-open this file exists to prevent. So `*` is a
    blanket unless a negation after the last one is *demonstrably* effective.

    Two ways a negation after `*` does nothing, both measured against git with
    `check-ignore` in this repository rather than reasoned about:

    - **It names a path below the top level.** `*` has already excluded the
      parent directory, and git cannot re-include a file whose parent is
      excluded, so `*` then `!child/file` leaves `child/file` matched by `*`.
    - **A later positive rule re-excludes the same name.** `*`, `!keep`,
      `keep` leaves `keep` matched by the third rule. A later positive *glob*
      is unreadable here and is assumed to re-exclude, which is the same bias.

    Raised by Copilot, round 2. The first version asked only whether any
    negation followed the last `*`, and both shapes above answered yes.

    **`.gitignore` alone, of the four names above.** Git is the only reader
    that honours an ignore file at depth; a nested `.codeindexignore` is read
    by nothing at all, so it hides the directory from nobody and creates no
    disagreement to gate.
    """
    path = directory / ".gitignore"
    if not path.is_file():
        return False
    rules = significant(path)
    if "*" not in rules:
        return False
    last_star = max(index for index, rule in enumerate(rules) if rule == "*")
    after = rules[last_star + 1:]
    for index, rule in enumerate(after):
        if not rule.startswith("!"):
            continue
        body = rule[1:].strip("/")
        if not body or "/" in body:
            continue
        later = [one for one in after[index + 1:] if not one.startswith("!")]
        if any(one.strip("/") == body or GLOB & set(one) for one in later):
            continue
        return False
    return True


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
        self.assertEqual(["state"], self_ignoring(self.root, []))

    def test_it_is_found_below_the_top_level(self):
        # `.superpowers/sdd/` is this shape: the blanket file sits one level
        # down, and the directory above it holds nothing else at all.
        self.write("tools/sdd/.gitignore", "*\n")
        self.assertEqual(["tools/sdd"], self_ignoring(self.root, []))

    def test_an_ordinary_nested_ignore_is_not_a_blanket(self):
        self.write("src/.gitignore", "build/\n*.log\n")
        self.assertEqual([], self_ignoring(self.root, []))

    def test_a_negation_after_the_star_leaves_the_directory_visible(self):
        self.write("state/.gitignore", "*\n!keep-me\n")
        self.assertEqual([], self_ignoring(self.root, []))

    def test_a_negation_before_the_star_is_overridden_by_it(self):
        # The mirror of the case above, and the one the first version of this
        # file got wrong: it refused any file holding a `!` at all, so a
        # directory that really is ignored whole went unreported. Copilot's
        # round-1 finding is about the root matcher; this is the same defect
        # in the nested one.
        self.write("state/.gitignore", "!keep-me\n*\n")
        self.assertEqual(["state"], self_ignoring(self.root, []))

    def test_comments_and_blanks_are_not_rules(self):
        self.write("state/.gitignore", "\n# everything\n*\n\n")
        self.assertEqual(["state"], self_ignoring(self.root, []))

    def test_a_covered_directory_is_still_reported(self):
        # Reported, because the assertion below needs a subject to pass ON —
        # a scanner that dropped covered directories would make the live case
        # vacuous a second way. Not descended into, because everything under
        # it is covered by construction.
        self.write("state/.gitignore", "*\n")
        self.write("state/inner/.gitignore", "*\n")
        self.assertEqual(["state"], self_ignoring(self.root, parse(["state/"])))

    def test_a_covered_tree_is_not_walked(self):
        self.write("vendor/pkg/.gitignore", "*\n")
        self.assertEqual([], self_ignoring(self.root, parse(["vendor/"])))
        # And the same tree with nothing covering it, so the case above is
        # about the rule rather than about the scanner failing to look.
        self.assertEqual(["vendor/pkg"], self_ignoring(self.root, []))

    def test_the_git_directory_is_never_walked(self):
        self.write(".git/modules/thing/.gitignore", "*\n")
        self.assertEqual([], self_ignoring(self.root, []))

    def test_a_negation_below_the_top_level_re_includes_nothing(self):
        # Measured: `git check-ignore -v` reports `child/file` matched by the
        # `*` on line 1, because git cannot re-include a file whose parent
        # directory is excluded. So this directory IS ignored whole, and the
        # first version of `blanket` reported it as not a blanket — a
        # self-ignoring directory the gate would then never ask about.
        self.write("state/.gitignore", "*\n!child/file\n")
        self.write("state/child/file", "x\n")
        self.assertEqual(["state"], self_ignoring(self.root, []))

    def test_a_later_positive_rule_re_excludes_a_negated_name(self):
        # Measured: `keep` is matched by line 3, not by the `!keep` on line 2.
        self.write("state/.gitignore", "*\n!keep\nkeep\n")
        self.assertEqual(["state"], self_ignoring(self.root, []))

    def test_an_unreadable_later_positive_is_assumed_to_re_exclude(self):
        # The bias stated in `blanket`: a glob cannot be evaluated here, and
        # guessing it ineffective is the direction that loses the directory.
        self.write("state/.gitignore", "*\n!keep\nk*\n")
        self.assertEqual(["state"], self_ignoring(self.root, []))

    def test_an_effective_negation_is_still_honoured(self):
        # The control for all three above — measured as NOT ignored, so this
        # directory is genuinely not a blanket and must not be reported.
        self.write("state/.gitignore", "*\n!keep\n")
        self.assertEqual([], self_ignoring(self.root, []))


class TheMatcherReadsTheSpellingsGitAccepts(unittest.TestCase):

    def test_each_plain_directory_spelling_covers(self):
        for rule in (".remember", ".remember/", "/.remember", "/.remember/"):
            with self.subTest(rule=rule):
                self.assertTrue(covered(".remember", parse([rule])))

    def test_an_ancestor_covers_what_sits_under_it(self):
        self.assertTrue(covered(".superpowers/sdd", parse([".superpowers/"])))

    def test_a_descendant_does_not_cover_its_parent(self):
        self.assertFalse(covered(".superpowers", parse([".superpowers/sdd/"])))

    def test_an_unrelated_rule_does_not_cover(self):
        self.assertFalse(covered(".remember", parse(["node_modules/", "/dist"])))

    def test_a_pattern_without_a_slash_matches_at_any_depth(self):
        # `__pycache__/` is the live example, and a rooted-only matcher would
        # have missed every one below the top level.
        self.assertTrue(covered("src/app/__pycache__", parse(["__pycache__/"])))

    def test_a_rooted_pattern_matches_only_at_the_root(self):
        self.assertTrue(covered("dist", parse(["/dist"])))
        self.assertFalse(covered("src/dist", parse(["/dist"])))

    def test_a_positive_glob_establishes_no_coverage(self):
        # Failing closed, per `covered`'s docstring: the fix for a directory
        # this reports is a plain rule, never a cleverer matcher here.
        self.assertFalse(covered(".remember", parse([".rem*/"])))


class WhitespaceIsReadTheWayGitReadsIt(unittest.TestCase):
    """Copilot, round 2: `.strip()` made an indented rule effective.

    Both halves measured with `git check-ignore` in this repository: a
    trailing space is git's to drop, and a leading one is part of the
    pattern. Stripping both turned ` .remember/` — which excludes nothing —
    into coverage.
    """

    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, str(self.root), ignore_errors=True)

    def root_ignore(self, text):
        (self.root / ".gitignore").write_text(text, encoding="utf-8",
                                              newline="\n")
        return root_rules(self.root)

    def test_a_leading_space_makes_the_rule_a_different_pattern(self):
        self.assertFalse(covered(".remember", self.root_ignore(" .remember/\n")))

    def test_a_trailing_space_is_dropped(self):
        self.assertTrue(covered(".remember", self.root_ignore(".remember/   \n")))

    def test_a_whitespace_only_line_is_blank(self):
        rules = self.root_ignore("   \n.remember/\n")
        self.assertEqual([(False, ".remember/")], rules)

    def test_an_indented_negation_undoes_nothing(self):
        # The case that decides whether keeping leading whitespace is safe in
        # both directions, and the one an lstrip would get wrong the other
        # way round. Measured: with `keep` then `  !keep`, `git check-ignore`
        # reports `keep` matched by line 1 — the indented negation does
        # nothing, so coverage survives it.
        rules = self.root_ignore(".remember/\n  !.remember/\n")
        self.assertTrue(covered(".remember", rules))


class TheMatcherReadsTheRulesInOrder(unittest.TestCase):
    """Copilot, round 1: a set of rules cannot see a negation undo a rule.

    The finding was that `root_rules` collapsed the files into a set, so
    `covered` knew only that a positive rule had appeared somewhere — and
    `!.remember/` written after `.remember/` would leave the index reading the
    tree while this gate stayed green. That is the one direction a regression
    gate must not fail in, so order is now carried and read.
    """

    def test_a_later_negation_uncovers(self):
        self.assertFalse(covered(".remember", parse([".remember/", "!.remember/"])))

    def test_an_earlier_negation_is_overridden(self):
        self.assertTrue(covered(".remember", parse(["!.remember/", ".remember/"])))

    def test_a_negation_of_an_ancestor_uncovers(self):
        rules = parse([".superpowers/", "!.superpowers/"])
        self.assertFalse(covered(".superpowers/sdd", rules))

    def test_a_glob_negation_is_taken_at_its_word(self):
        # Unreadable, so it is assumed to bite: the gate goes red and the
        # answer is a plain rule. The opposite reading is the fail-open.
        self.assertFalse(covered(".remember", parse([".remember/", "!.rem*/"])))

    def test_a_positive_rule_after_a_glob_negation_covers_again(self):
        rules = parse([".remember/", "!.rem*/", ".remember/"])
        self.assertTrue(covered(".remember", rules))

    def test_negations_aimed_elsewhere_do_not_uncover(self):
        # The live shape: the root file negates four paths under `.vscode/`,
        # and none of them has anything to say about session state.
        rules = parse([
            ".vscode/*",
            "!.vscode/settings.json",
            "!.vscode/tasks.json",
            ".remember/",
        ])
        self.assertTrue(covered(".remember", rules))


class EveryBlanketIgnoreIsCoveredAtTheRoot(unittest.TestCase):
    """The live scan over this checkout — empty in CI, by construction."""

    def test_the_root_ignore_files_are_readable(self):
        # The positive control this class can hold on a CI checkout: the root
        # ignore files are tracked, so their rules are there whether or not
        # any session state is.
        rules = root_rules(ROOT)
        self.assertGreater(len(rules), 10)
        self.assertIn((False, "__pycache__/"), rules)

    def test_nothing_hides_from_git_and_not_from_the_index(self):
        rules = root_rules(ROOT)
        uncovered = [
            directory for directory in self_ignoring(ROOT, rules)
            if not covered(directory, rules)
        ]
        self.assertEqual(
            [], uncovered,
            "each of these holds a .gitignore of `*`, so git ignores it and "
            "the code index does not. Add it to the root .gitignore "
            "(blueprint-frontend#53).",
        )


class TheSessionStateTreesAreIgnoredAtTheRoot(unittest.TestCase):
    """The regression lock for blueprint-frontend#53, and the CI-side half.

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
