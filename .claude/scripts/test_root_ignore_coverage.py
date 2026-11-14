"""Nothing may be hidden from git and visible to the code index.

A directory every entry of which is hidden is `hidden_from_git_only`'s, and a file hidden
beside a tracked one is `files_hidden_from_git_only`'s. `docs/harness-local.md`, Residuals,
owns why git is asked rather than its patterns read, and what counts as covered."""

import atexit
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent.parent

# The root ignore file git itself reads. The indexer reads three more —
# `.codeindexignore`, `.cursorignore` and `.claudeignore` — and
# `docs/harness-local.md` argues why coverage is judged against this one alone.
ROOT_IGNORE = ".gitignore"

# A name no directory in this repository will hold, and which no narrow rule
# can match by accident. It is never created.
PROBE = "zz-root-ignore-coverage-probe"


def _check_ignore(root, flags, relatives):
    """Run `git check-ignore` over `relatives` and return its raw stdout.

    `-z` is what makes the output safe to split: a path or an ignore file
    holding a newline would otherwise break a record in two.
    """
    done = subprocess.run(
        ["git", "-c", "core.excludesFile=", "check-ignore", *flags,
         "-z", "--stdin"],
        cwd=str(root), input="\0".join(relatives),
        capture_output=True, text=True,
    )
    # 1 is "nothing matched", which is an answer. Anything else is not.
    if done.returncode not in (0, 1):
        raise AssertionError(f"git check-ignore failed: {done.stderr}")
    return done.stdout


def deciders(root, relatives):
    """`{path: deciding ignore file}` for the paths git ignores; the rest are absent.

    Two calls: `check-ignore -v` emits a record for a negation, for a path it does not
    ignore, so the plain call settles whether git ignores each path and the verbose one
    is asked only about the survivors, where every record is a positive decision."""
    if not relatives:
        return {}
    ignored = [path for path in _check_ignore(root, [], relatives).split("\0")
               if path]
    if not ignored:
        return {}
    fields = _check_ignore(root, ["-v"], ignored).split("\0")
    decided = {}
    for index in range(0, len(fields) - 3, 4):
        source, _line, _pattern, path = fields[index:index + 4]
        decided[path] = source
    return decided


_ROOT_ONLY_REPOS = {}


def _root_only_repo(root):
    """A scratch repository whose only ignore source is `root`'s root file.

    Built once per distinct text, because the walk asks about every directory it reaches.
    A checkout with no root file gets a repository with none, so the answer is covers
    nothing; `NothingInThisCheckoutHidesFromGitAlone` proves this checkout is not one."""
    source = Path(root, ROOT_IGNORE)
    text = source.read_text(encoding="utf-8") if source.is_file() else ""
    if text in _ROOT_ONLY_REPOS:
        return _ROOT_ONLY_REPOS[text]
    # TemporaryDirectory, not rmtree with ignore_errors: git writes its
    # objects read-only, Windows refuses to delete them, and the flag hid
    # every one that stayed.
    holder = tempfile.TemporaryDirectory()
    atexit.register(holder.cleanup)
    scratch = Path(holder.name)
    subprocess.run(["git", "init", "-q"], cwd=str(scratch), check=True,
                   capture_output=True)
    Path(scratch, ROOT_IGNORE).write_text(text, encoding="utf-8",
                                          newline="\n")
    _ROOT_ONLY_REPOS[text] = scratch
    return scratch


def root_only_hides(root, relatives):
    """The subset of `relatives` the root ignore file hides by itself.

    `docs/harness-local.md` argues why this is the question and the decider is not. A path
    is asked with a trailing slash where the real tree holds a directory, because
    `check-ignore` cannot tell a path it cannot see is one; a caller's own slash is kept."""
    if not relatives:
        return set()
    asked = {}
    for relative in relatives:
        spelling = relative
        if not spelling.endswith("/") and Path(root, relative).is_dir():
            spelling += "/"
        asked[spelling] = relative
    answered = _check_ignore(_root_only_repo(root), [], list(asked))
    return {asked[path] for path in answered.split("\0") if path in asked}


def hidden_whole(root, directory):
    """The non-root ignore file hiding every entry of `directory`, or `None`.

    One visible entry means the tools agree, and an empty directory has nothing to
    disagree about. Entries the root file reaches are ones the indexer skips too, so a
    directory whose every entry it reaches is no finding, whichever file git names."""
    base = Path(root, directory)
    try:
        names = sorted(entry.name for entry in base.iterdir()
                       if entry.name != ".git")
    except OSError:
        return None
    if not names:
        return None
    paths = [f"{directory}/{name}" for name in names]
    decided = deciders(root, paths)
    if any(path not in decided for path in paths):
        return None
    uncovered = [path for path in paths
                 if path not in root_only_hides(root, paths)]
    if not uncovered:
        return None
    return decided[uncovered[0]]


def hidden_from_git_only(root):
    """`(directory, source)` for every directory git hides that the index reads.

    Each directory is asked twice: whether it is hidden decides pruning, since only a root
    rule covering it means the indexer agrees, and whether everything in it is hidden
    decides the finding, since a directory's own `.gitignore` hides only its contents."""
    findings = []

    def walk(relative):
        base = Path(root, relative) if relative else Path(root)
        try:
            entries = sorted(base.iterdir())
        except OSError:
            return
        children = [
            f"{relative}/{entry.name}" if relative else entry.name
            for entry in entries
            if entry.name != ".git" and not entry.is_symlink() and entry.is_dir()
        ]
        if not children:
            return
        own = deciders(root, children)
        covered = root_only_hides(root, children)
        for child in children:
            covering = own.get(child)
            if covering is None:
                # Git can see the directory, so the two tools agree about it.
                # Any disagreement is about its contents, or further down.
                hiding = hidden_whole(root, child)
                if hiding is None:
                    walk(child)
                else:
                    findings.append((child, hiding))
                continue
            # Git hides the directory. Whether the indexer does too is the
            # root file's question alone, and asking which file git named
            # instead is the defect `docs/harness-local.md` records: a covered
            # directory a nested template also matches was reported for ever.
            # Either way the subtree is settled and is not descended into.
            if child not in covered:
                # A parent's `.gitignore` or an excludes file hides it, and
                # the indexer reads on.
                findings.append((child, covering))

    walk("")
    return findings


def files_hidden_from_git_only(root):
    """`(file, source)` for every file hidden from git that the index reads.

    The directory walk is silent wherever one tracked file keeps a directory visible, and
    this one reads those. It prunes at a directory git ignores and at one `hidden_whole`
    matches: that directory is the other walk's finding, stated once and not per file."""
    findings = []

    def walk(relative):
        base = Path(root, relative) if relative else Path(root)
        try:
            entries = sorted(base.iterdir())
        except OSError:
            return
        children, files = [], []
        for entry in entries:
            if entry.name == ".git" or entry.is_symlink():
                continue
            path = f"{relative}/{entry.name}" if relative else entry.name
            (children if entry.is_dir() else files).append(path)
        if files:
            decided = deciders(root, files)
            nested = [path for path in files
                      if decided.get(path) not in (None, ROOT_IGNORE)]
            if nested:
                covered = root_only_hides(root, nested)
                findings.extend((path, decided[path]) for path in nested
                                if path not in covered)
        if children:
            ignored = deciders(root, children)
            for child in children:
                if child in ignored:
                    continue
                if hidden_whole(root, child) is None:
                    walk(child)

    walk("")
    return findings


class GitIsReallyBeingAsked(unittest.TestCase):
    """The control on the mechanism every other case here rests on.

    `deciders` returning an empty map would make the live scan green and the coverage
    assertions red in a way that reads as a missing rule, so the call is proved first.
    """

    def setUp(self):
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        self.root = Path(holder.name)
        subprocess.run(["git", "init", "-q"], cwd=str(self.root), check=True,
                       capture_output=True)

    def write(self, relative, text):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8", newline="\n")

    def test_an_ignored_path_reports_the_file_that_decided_it(self):
        self.write(".gitignore", "state/\n")
        self.assertEqual({f"state/{PROBE}": ".gitignore"},
                         deciders(self.root, [f"state/{PROBE}"]))

    def test_a_nested_file_is_reported_as_the_decider(self):
        self.write("state/.gitignore", "*\n")
        self.assertEqual({f"state/{PROBE}": "state/.gitignore"},
                         deciders(self.root, [f"state/{PROBE}"]))

    def test_an_unignored_path_is_absent(self):
        self.write(".gitignore", "other/\n")
        self.assertEqual({}, deciders(self.root, [f"state/{PROBE}"]))

    def test_it_answers_for_a_path_that_does_not_exist(self):
        # The property the CI-side assertions depend on: nothing is created
        # here, and git answers anyway.
        self.write(".gitignore", "state/\n")
        self.assertFalse((self.root / "state").exists())
        self.assertIn(f"state/{PROBE}", deciders(self.root, [f"state/{PROBE}"]))

    def test_several_paths_come_back_from_one_call(self):
        self.write(".gitignore", "one/\n")
        self.write("two/.gitignore", "*\n")
        decided = deciders(self.root, [f"one/{PROBE}", f"two/{PROBE}",
                                       f"three/{PROBE}"])
        self.assertEqual({f"one/{PROBE}": ".gitignore",
                          f"two/{PROBE}": "two/.gitignore"}, decided)

    def test_an_empty_request_asks_nothing(self):
        self.assertEqual({}, deciders(self.root, []))

    def test_a_path_a_negation_re_admits_is_not_decided(self):
        # Measured: the verbose form reports `.gitignore:2:!keep` for `keep`
        # and exits 0, while the plain form prints nothing and exits 1. The
        # path is not ignored, so nothing decided it.
        self.write(".gitignore", "*\n!keep\n")
        self.assertEqual({}, deciders(self.root, ["keep"]))

    def test_a_negation_does_not_hide_what_it_re_admits_beside(self):
        # The positive half of the case above: `other` really is ignored, so
        # dropping the negation must not drop it too.
        self.write(".gitignore", "*\n!keep\n")
        self.assertEqual({"other": ".gitignore"},
                         deciders(self.root, ["keep", "other"]))

    def test_the_root_file_is_asked_where_nothing_can_outrank_it(self):
        # The control on `root_only_hides`: a rule that matches, and one that
        # does not, so an empty set cannot pass for either answer.
        self.write(".gitignore", "/state/\n")
        (self.root / "state").mkdir()
        (self.root / "other").mkdir()
        self.assertEqual({"state"},
                         root_only_hides(self.root, ["state", "other"]))

    def test_a_directory_that_need_not_exist_spells_its_own_slash(self):
        # `check-ignore` cannot tell that a path it cannot see is a
        # directory, and the scratch repository holds none, so `/build/`
        # reaches `build/` and not `build`. The regression locks at the foot
        # of this file ask about paths a clean checkout does not have.
        self.write(".gitignore", "/build/\n")
        self.assertFalse((self.root / "build").exists())
        self.assertEqual({"build/"}, root_only_hides(self.root, ["build/"]))
        self.assertEqual(set(), root_only_hides(self.root, ["build"]))

    def test_a_real_directory_gets_its_slash_without_being_asked(self):
        self.write(".gitignore", "/build/\n")
        (self.root / "build").mkdir()
        self.assertEqual({"build"}, root_only_hides(self.root, ["build"]))

    def test_no_root_file_covers_nothing(self):
        # A checkout without the file scans clean for the wrong reason, which
        # is what `test_the_root_ignore_file_is_where_it_is_expected` exists
        # to catch. Here it must simply not raise.
        self.assertEqual(set(), root_only_hides(self.root, ["anything/"]))


class TheGateSeesEveryWayGitCanHideADirectory(unittest.TestCase):
    """The load-bearing class: what the gate is looking at, not what it found.

    Each spelling was measured with `git status --ignored=matching` before it was
    written down, and the open-ended list is the argument for delegating to git.
    """

    def setUp(self):
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        self.root = Path(holder.name)
        subprocess.run(["git", "init", "-q"], cwd=str(self.root), check=True,
                       capture_output=True)

    def write(self, relative, text):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8", newline="\n")

    def test_every_blanket_spelling_is_caught(self):
        # `?*` is the reason this file
        # stopped keeping a set of these. Nothing recognises them now — each
        # directory holds two ordinary files and the question is whether git
        # can see either.
        for spelling in ("*", "/*", "**", "/**", "?*", "*?", "?**"):
            with self.subTest(spelling=spelling):
                holder = tempfile.TemporaryDirectory()
                self.addCleanup(holder.cleanup)
                root = Path(holder.name)
                subprocess.run(["git", "init", "-q"], cwd=str(root),
                               check=True, capture_output=True)
                state = root / "state"
                state.mkdir()
                (state / ".gitignore").write_text(spelling + "\n",
                                                  encoding="utf-8", newline="\n")
                for name in ("top.txt", "endsz"):
                    (state / name).write_text("x\n", encoding="utf-8",
                                              newline="\n")
                self.assertEqual([("state", "state/.gitignore")],
                                 hidden_from_git_only(root))

    def test_a_rule_that_only_looks_universal_is_not_a_finding(self):
        # `*[!zzz]` was in the blanket set at round 4, on a measurement that
        # used `top.txt` and `sub/deep.txt` — neither ending in `z`. It leaves
        # a name ending in `z` visible, so the directory is not hidden and the
        # tools do not disagree about it. Measured; Copilot, round 8. The
        # entry is gone and the case is what stops it coming back.
        self.write("state/.gitignore", "*[!zzz]\n")
        self.write("state/top.txt", "x\n")
        self.write("state/endsz", "x\n")
        self.assertEqual([], hidden_from_git_only(self.root))

    def test_a_nested_rule_matching_the_sentinel_alone_is_not_a_finding(self):
        # Copilot, round 8, and the other direction of round 7's defect: a
        # nested `zz-*` matches the sentinel's name and nothing else, so
        # `visible.txt` is plainly still visible. Deciding from one name
        # reported this directory; deciding from its entries does not.
        self.write("state/.gitignore", "zz-*\n")
        self.write("state/visible.txt", "x\n")
        self.write(f"state/{PROBE}", "x\n")
        self.assertEqual([], hidden_from_git_only(self.root))

    def test_an_empty_directory_is_not_a_finding(self):
        # Nothing in it for the index to read, so nothing to disagree about.
        (self.root / "state").mkdir()
        self.assertEqual([], hidden_from_git_only(self.root))

    def test_a_root_rule_is_not_a_finding(self):
        self.write(".gitignore", "state/\n")
        self.write("state/.gitignore", "*\n")
        self.assertEqual([], hidden_from_git_only(self.root))

    def test_a_narrow_nested_rule_is_not_a_finding(self):
        # The probe is what makes this pass without enumerating anything: a
        # rule that hides build output does not hide arbitrary names, so the
        # two tools do not disagree about the directory.
        self.write("src/.gitignore", "build/\n*.log\n")
        self.assertEqual([], hidden_from_git_only(self.root))

    def test_a_directory_only_rule_is_caught_at_the_subdirectory(self):
        # `*/` hides subdirectories and leaves top-level files visible, so the
        # disagreement is about `state/sub` and the finding names it. The
        # matcher this replaced called `*/` "not a blanket" and reported
        # nothing at all, which lost a real disagreement.
        self.write("state/.gitignore", "*/\n")
        self.write("state/top.txt", "x\n")
        (self.root / "state" / "sub").mkdir()
        self.assertEqual([("state/sub", "state/.gitignore")],
                         hidden_from_git_only(self.root))

    def test_it_is_found_below_the_top_level(self):
        # `.superpowers/sdd/` is this shape: the nested file sits one level
        # down, and the directory above it holds nothing else.
        self.write("tools/sdd/.gitignore", "*\n")
        self.assertEqual([("tools/sdd", "tools/sdd/.gitignore")],
                         hidden_from_git_only(self.root))

    def test_a_negation_that_re_admits_nothing_is_still_a_finding(self):
        # Measured: `*` then `!child/file` leaves the file matched by `*`,
        # because git cannot re-include under an excluded parent.
        self.write("state/.gitignore", "*\n!child/file\n")
        self.assertEqual([("state", "state/.gitignore")],
                         hidden_from_git_only(self.root))

    def test_a_later_positive_rule_re_excludes_a_negated_name(self):
        # Measured: `keep` is matched by line 3, not by the `!keep` above it.
        self.write("state/.gitignore", "*\n!keep\nkeep\n")
        self.assertEqual([("state", "state/.gitignore")],
                         hidden_from_git_only(self.root))

    def test_ordering_is_gits_to_get_right(self):
        # The round-1 finding. Nothing here reads the order — git does.
        self.write(".gitignore", "state/\n!state/\n")
        self.write("state/.gitignore", "*\n")
        self.assertEqual([("state", "state/.gitignore")],
                         hidden_from_git_only(self.root))

    def test_whitespace_is_gits_to_get_right(self):
        # The round-2 finding. An indented root rule excludes nothing, so the
        # nested file decides and the directory is reported.
        self.write(".gitignore", " state/\n")
        self.write("state/.gitignore", "*\n")
        self.assertEqual([("state", "state/.gitignore")],
                         hidden_from_git_only(self.root))

    def test_a_root_rule_matching_only_the_probe_does_not_prune(self):
        # Copilot round 7. `zz-*` matches the probe's name at any depth and
        # covers `state` not at all, so reading that as coverage skipped the
        # directory and never reached the nested file below it. Pruning asks
        # about the directory now; the probe only ever raises a finding.
        self.write(".gitignore", "zz-*\n")
        self.write("state/inner/.gitignore", "*\n")
        self.assertEqual([("state/inner", "state/inner/.gitignore")],
                         hidden_from_git_only(self.root))

    def test_a_parent_rule_hiding_a_directory_is_a_finding(self):
        # The other half of asking about the directory itself: a nested file
        # one level up hides `state/sub` outright, and the indexer reads it.
        # It does not pin the pruning fix, since the probe inside finds the
        # same rule; it stays as cover for the directory-level branch, which
        # nothing else reaches. The case above is the one that discriminates.
        self.write("state/.gitignore", "sub/\n")
        (self.root / "state" / "sub").mkdir(parents=True)
        self.assertEqual([("state/sub", "state/.gitignore")],
                         hidden_from_git_only(self.root))

    def test_a_negated_probe_does_not_hide_the_subtree_under_it(self):
        # Copilot round 6 at the level that matters. A root rule hides
        # everything and then re-admits `state` and its contents, so the
        # probe inside `state` is decided by a NEGATION. Reading the record
        # `-v` emits for that as coverage made the walk skip `state`, and the
        # nested file below it was never reached.
        self.write(".gitignore", "*\n!state\n!state/**\n")
        self.write("state/inner/.gitignore", "*\n")
        self.assertEqual([("state/inner", "state/inner/.gitignore")],
                         hidden_from_git_only(self.root))

    def test_the_git_directory_is_never_walked(self):
        self.write(".git/modules/thing/.gitignore", "*\n")
        self.assertEqual([], hidden_from_git_only(self.root))

    def test_a_generated_file_beside_a_tracked_one_is_a_file_finding(self):
        # The shape the directory walk is blind to, and the six real ones it
        # let through: `kept.txt` keeps the directory visible, so nothing is
        # wholly hidden, while `generated.json` is read by the indexer.
        self.write("app/.gitignore", "generated.json\n")
        self.write("app/generated.json", "{}\n")
        self.write("app/kept.txt", "x\n")
        self.assertEqual([], hidden_from_git_only(self.root))
        self.assertEqual([("app/generated.json", "app/.gitignore")],
                         files_hidden_from_git_only(self.root))

    def test_a_root_covered_file_is_not_a_file_finding(self):
        # The fix clears it: the root file reaches the same path, so the two
        # tools agree although git still names the nested file as decider.
        self.write(".gitignore", "/app/generated.json\n")
        self.write("app/.gitignore", "generated.json\n")
        self.write("app/generated.json", "{}\n")
        self.write("app/kept.txt", "x\n")
        self.assertEqual([], files_hidden_from_git_only(self.root))

    def test_an_ignored_directory_is_not_descended_into_for_files(self):
        # A directory the nested file hides is the directory walk's finding,
        # and repeating it once per file inside would bury it. `*` in a nested
        # file leaves the directory itself visible to git, so the skip taken
        # here is `hidden_whole`'s and not the other prune; the case below is
        # the one that discriminates.
        self.write("state/.gitignore", "*\n")
        self.write("state/one.txt", "x\n")
        self.write("state/two.txt", "x\n")
        self.assertEqual([("state", "state/.gitignore")],
                         hidden_from_git_only(self.root))
        self.assertEqual([], files_hidden_from_git_only(self.root))

    def test_a_directly_ignored_directory_is_never_entered(self):
        """The prune no result can prove, so the traversal is the subject.

        Deleting `if child in ignored: continue` leaves every other case green while the
        walk enters every root-covered tree, so this records what the walk asked about.
        `deciders` is rebound on the module: the walk resolves it as a global."""
        self.write(".gitignore", "vendor/\n")
        self.write("vendor/pkg/generated.json", "{}\n")
        self.write("vendor/pkg/kept.txt", "x\n")

        asked = []
        original = globals()["deciders"]

        def spy(root, relatives):
            asked.extend(relatives)
            return original(root, relatives)

        globals()["deciders"] = spy
        try:
            self.assertEqual([], files_hidden_from_git_only(self.root))
        finally:
            globals()["deciders"] = original

        # The control: the walk really ran and really considered `vendor`.
        self.assertIn("vendor", asked)
        # And stopped there.
        self.assertEqual(
            [], [path for path in asked if path.startswith("vendor/")],
            "the walk entered a directory the root file covers")

    def test_a_file_the_root_file_hides_is_never_a_finding(self):
        # What keeps `node_modules/` and every ordinary build output out.
        self.write(".gitignore", "*.log\n")
        self.write("app/debug.log", "x\n")
        self.assertEqual([], files_hidden_from_git_only(self.root))

    def test_a_covered_tree_is_not_descended_into(self):
        # Everything under a covered directory is covered, and this is what
        # keeps `node_modules/` from dominating the walk.
        self.write(".gitignore", "vendor/\n")
        self.write("vendor/pkg/.gitignore", "*\n")
        self.assertEqual([], hidden_from_git_only(self.root))
        # The same tree with nothing covering it, so the case above is about
        # the rule rather than about the walk failing to look.
        self.write(".gitignore", "\n")
        self.assertEqual([("vendor/pkg", "vendor/pkg/.gitignore")],
                         hidden_from_git_only(self.root))

    def test_a_root_rule_clears_a_finding_a_nested_file_still_decides(self):
        # The defect the native trees found, in the smallest tree that shows
        # it: `outer` is tracked, so git names `outer/.gitignore` for
        # `outer/state` although the root file covers that path too, and a gate
        # reading the decider went on reporting a directory its advice had
        # fixed. The two assertions are git's decider and the indexer's coverage.
        self.write(".gitignore", "/outer/state/\n")
        self.write("outer/.gitignore", "state/\n")
        self.write("outer/state/top.txt", "x\n")
        self.assertEqual({"outer/state": "outer/.gitignore"},
                         deciders(self.root, ["outer/state"]))
        self.assertEqual([], hidden_from_git_only(self.root))

    def test_the_same_tree_without_the_root_rule_is_a_finding(self):
        # The other direction of the case above, so it cannot pass by the
        # gate having stopped looking at nested files altogether.
        self.write("outer/.gitignore", "state/\n")
        self.write("outer/state/top.txt", "x\n")
        self.assertEqual([("outer/state", "outer/.gitignore")],
                         hidden_from_git_only(self.root))


class NothingInThisCheckoutHidesFromGitAlone(unittest.TestCase):

    def test_the_root_ignore_file_is_where_it_is_expected(self):
        # The positive control for the live scan: a checkout without this
        # file would scan clean for the wrong reason.
        self.assertTrue((ROOT / ROOT_IGNORE).is_file())

    def test_no_directory_is_hidden_from_git_and_read_by_the_index(self):
        findings = hidden_from_git_only(ROOT)
        self.assertEqual(
            [], findings,
            "each of these is hidden from git by the ignore file named beside "
            "it, which the code index does not read. Add it to the root "
            ".gitignore (blueprint-frontend#53).",
        )

    def test_no_file_is_hidden_from_git_and_read_by_the_index(self):
        # The same question one level down, and the one the directory case
        # cannot answer: a generated file beside a tracked one leaves its
        # directory plainly visible. Vacuous on a clean checkout for the same
        # reason the case above is, which is what the regression lock at the
        # foot of this file exists for.
        findings = files_hidden_from_git_only(ROOT)
        self.assertEqual(
            [], findings,
            "each of these is a file hidden from git by the ignore file named "
            "beside it, which the code index reads. Add it to the root "
            ".gitignore (blueprint-frontend#53).",
        )


class TheSessionStateTreesAreCoveredAtTheRoot(unittest.TestCase):
    """The regression lock for the session-state trees, and it holds in CI.

    `.remember/` and `.superpowers/` are local, so a checkout without them scans clean
    whether or not the root rules survived. These ask about paths inside them regardless
    of whether they are there."""

    def test_remember_is_covered_by_the_root_file(self):
        decided = deciders(ROOT, [f".remember/{PROBE}"])
        self.assertEqual(ROOT_IGNORE, decided.get(f".remember/{PROBE}"))

    def test_superpowers_is_covered_by_the_root_file(self):
        # Asked at the depth the nested file actually sits at, so the
        # ancestor rule is what has to answer for it.
        decided = deciders(ROOT, [f".superpowers/sdd/{PROBE}"])
        self.assertEqual(ROOT_IGNORE, decided.get(f".superpowers/sdd/{PROBE}"))


class TheNativeGeneratedTreesAreCoveredAtTheRoot(unittest.TestCase):
    """The regression lock for what `cap sync` and Gradle write, and it holds in CI.

    These directories exist only in a checkout that has built, so CI's tree scans green
    whether or not the root rules survive, and a developer's checkout is where the index
    is built. Asked with a trailing slash: git cannot tell an unseen path is a directory."""

    GENERATED = (
        "android/.gradle/",
        "android/build/",
        "android/app/build/",
        "android/app/src/main/assets/public/",
        "android/capacitor-cordova-android-plugins/",
        "ios/App/build/",
        "ios/App/output/",
        "ios/App/Pods/",
        "ios/App/App/public/",
        "ios/DerivedData/",
        "ios/capacitor-cordova-ios-plugins/",
        "ios/App/App.xcodeproj/xcuserdata/",
        "ios/App/App.xcodeproj/project.xcworkspace/xcuserdata/",
        "ios/App/CapApp-SPM/.build/",
        "android/.kotlin/",
        "android/captures/",
        "android/app/release/",
        "android/.cxx/",
        "android/app/.cxx/",
        "android/.navigation/",
        "android/.externalNativeBuild/",
        "android/app/.externalNativeBuild/",
    )

    # The generated files, which need naming more than the directories do. The assets pair
    # and the SwiftPM pair each have a directory to themselves, and the release bundle sits
    # in one the root hides whole; the rest sit beside tracked content, so the directory
    # scan can never reach them. `local.properties` also carries an absolute SDK path from
    # whichever machine ran the build.
    GENERATED_FILES = (
        "android/app/src/main/assets/capacitor.config.json",
        "android/app/src/main/assets/capacitor.plugins.json",
        "android/app/src/main/res/xml/config.xml",
        "android/local.properties",
        "ios/App/App/capacitor.config.json",
        "ios/App/App/config.xml",
        "ios/App/CapApp-SPM/.swiftpm/config/registries.json",
        "ios/App/CapApp-SPM/.swiftpm/xcode/package.xcworkspace/contents.xcworkspacedata",
        "android/app/release/app-release.aab",
        "android/app/build-debug.apk",
        "android/app/hs_err.hprof",
        "android/app/app.iml",
    )

    def test_the_root_file_hides_every_generated_native_tree(self):
        # The whole set in one assertion, so a line dropped from the root
        # file fails here and names itself.
        self.assertEqual(set(self.GENERATED),
                         root_only_hides(ROOT, list(self.GENERATED)))

    def test_the_root_file_hides_every_generated_native_file(self):
        # No trailing slash and none wanted: these are files, and
        # `check-ignore` answers for a path it cannot see as long as the rule
        # does not end in one.
        self.assertEqual(set(self.GENERATED_FILES),
                         root_only_hides(ROOT, list(self.GENERATED_FILES)))


class GradlewBatStaysCrlf(unittest.TestCase):
    """`.gitattributes` keeps a Windows batch file CRLF on its next re-add."""

    def test_bat_and_cmd_files_are_checked_out_crlf(self):
        for path in ("android/gradlew.bat", "x/run.cmd"):
            with self.subTest(path=path):
                done = subprocess.run(["git", "check-attr", "eol", path], cwd=str(ROOT),
                                      capture_output=True, text=True, check=True)
                self.assertTrue(done.stdout.strip().endswith("eol: crlf"), done.stdout)


if __name__ == "__main__":
    unittest.main()
