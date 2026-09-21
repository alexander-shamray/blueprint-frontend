"""No directory may be hidden from git and visible to the code index.

**The subject is the disagreement between the two, not either one of them.**
Git honours a `.gitignore` at any depth, so a directory holding one that says
`*` vanishes from `git status` and from `git ls-files` — which is why
`.remember/` and `.superpowers/sdd/` looked correctly excluded in this
repository for as long as they did. The indexer reads only the root ignore
files its config names, so the same nested file is invisible to it and both
trees were indexed whole, session logs included: text from PR comments,
reviews and sweeps came back ranked beside code as `recommended_reads`.
blueprint-frontend#53 owns the measurement, which moves with the checkout, so
it is cited here rather than copied.

**Every issue number in this file names the frontend repository and says so.**
`CLAUDE.md` reads a bare `#NN` under `.claude/` as an issue in the *backend*,
where this machinery was built, so an unqualified `#53` here points a reader
at the wrong tracker. `blueprint-frontend#45` is the spelling already used in
`guard-edit-target.py` and `test_edit_target_guard.py`.

## Git answers the questions about git

This file asks `git check-ignore` rather than matching patterns itself, and
that is the whole of its design. An earlier version matched them here, and
across five review rounds it was wrong five times — ordered negations, leading
whitespace, whether a negation after `*` is effective, and twice about which
spellings hide a directory completely. Every one failed **open**: the gate said
covered, or said not-hidden, where git said otherwise.

The last of them settled it. `*`, `/*`, `**`, `/**`, `?*`, `*?`, `?**` and
`*[!zzz]` were each measured to hide a directory entirely, and there is no end
to that list — any glob matching every possible name belongs to it. A set of
blanket spellings cannot be completed by enumeration, so a gate resting on one
cannot be made correct by adding the spelling somebody just found.

So nothing here parses an ignore file. `git check-ignore` names the file and
line that decided a path, and that is both halves of the question at once:
whether git hides the directory, and whether the rule that hides it is one the
indexer can see.

Delegating is not the same as trusting one call to mean what it looks like.
The verbose form reports a *negation* as a decision, for a path it does not
ignore, so `deciders` asks twice — the plain form for whether a path is
ignored at all, the verbose one only about the paths that survived it. That
is argued where it happens.

## The probe does the discriminating

Each candidate directory is asked about one path inside it, spelled with a
name nothing will ever be called. That name is what separates *hides
everything* from *hides something specific* without enumerating either: a
nested `*.log` cannot match it, and a nested `*` or `?*` matches it the way it
matches any other name.

**The probe never has to exist**, which is what makes the assertions below
real on a CI checkout. `.remember/` and `.superpowers/` are local session
state and a fresh checkout has neither, yet `check-ignore` still answers for a
path inside them — measured, `.gitignore:67:.remember/`. The earlier version
could only scan directories that were present, so its live case ran on an
empty listing exactly where the suite gates.

## What counts as covered, and which way it fails

Coverage is the root `.gitignore` hiding the directory **on its own**, asked
in a scratch repository holding that file and nothing else. Any directory it
does not reach is hidden from git by something the indexer cannot see — a
nested `.gitignore`, `.git/info/exclude`, a global excludes file — and that is
the finding.

**Reading the *decider* was wrong, and it made this file's own advice
unfollowable.** Git gives a deeper `.gitignore` precedence over the root one
and names the deeper file whenever both match, so a rule added to the root
file to cover a directory a nested template already hides moves no decider at
all: the finding stands, the advice repeats itself, and nothing the reader can
do to the root file will ever clear it. Measured — with `/sub/build/` at the
root and `build/` in `sub/`, `check-ignore -v` answers
`sub/.gitignore:1:build/`.

The session-state trees never showed this, which is why it survived eight
review rounds. A root rule spelling `.remember/` excludes the directory
itself, and git does not descend into an excluded directory, so the
`.gitignore` inside it is never read and the root file is the only decider
there is. The native trees are the shape that discriminates:
`android/.gitignore` and `ios/.gitignore` are Capacitor's own templates,
sitting in directories this repository tracks, and every rule in them outranks
anything the root file can say.

That is still narrower than the indexer's own reading, deliberately. The
indexer also consults `.codeindexignore`, `.cursorignore` and `.claudeignore`
at the root, and git reads none of them; so a directory covered only by
`.codeindexignore` is reported here although the indexer would in fact skip
it. The report is then a false one, and it fails in the safe direction: the
fix it asks for is a rule in the root `.gitignore`, which is where
`blueprint-backend` and `blueprint-admin` put theirs, where this repository
wants it anyway — and which now actually clears the finding.

The user's global excludes file is emptied for every call. Without that, a
developer's personal `~/.gitignore` decides paths here and the gate reports
findings that exist on one machine.
"""

import atexit
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent.parent

# The root ignore file git itself reads. The indexer reads three more —
# `.codeindexignore`, `.cursorignore` and `.claudeignore` — and the module
# docstring argues why coverage is judged against this one alone.
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
    """`{path: deciding ignore file}` for the paths git ignores.

    Paths git does not ignore are absent rather than present with `None`, so
    a caller asking about many directories reads the answer by membership.

    **Two calls, and neither of them reads a pattern.** `check-ignore -v`
    emits a record when the deciding rule is a *negation*, for a path it does
    not ignore — measured: with `*` then `!keep`, the verbose form reports
    `.gitignore:2:!keep` and exits 0 while the plain form prints nothing and
    exits 1. One verbose call therefore recorded un-ignored paths as decided,
    and that went wrong in both directions at once: a root negation matching
    the probe read as coverage and the walk skipped the subtree beneath it,
    and a nested one read as a finding that was not there. Raised by Copilot,
    round 6.

    So the plain call settles *whether* git ignores each path, which is git's
    own answer rather than this file's reading of one, and the verbose call is
    asked only about the paths that survived it — where every record is a
    positive decision by construction. Dropping verbose records whose pattern
    starts with `!` would also work, and would put pattern reading back into a
    file whose whole design is not doing that.
    """
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

    Built once per distinct text and reused, because the walk below asks
    about every directory it reaches. A checkout with no root ignore file
    gets a repository with none either, so the answer is *covers nothing*
    rather than an error — and `NothingInThisCheckoutHidesFromGitAlone` has
    the positive control that this checkout is not that one.
    """
    source = Path(root, ROOT_IGNORE)
    text = source.read_text(encoding="utf-8") if source.is_file() else ""
    if text in _ROOT_ONLY_REPOS:
        return _ROOT_ONLY_REPOS[text]
    scratch = Path(tempfile.mkdtemp())
    atexit.register(shutil.rmtree, str(scratch), ignore_errors=True)
    subprocess.run(["git", "init", "-q"], cwd=str(scratch), check=True,
                   capture_output=True)
    Path(scratch, ROOT_IGNORE).write_text(text, encoding="utf-8",
                                          newline="\n")
    _ROOT_ONLY_REPOS[text] = scratch
    return scratch


def root_only_hides(root, relatives):
    """The subset of `relatives` the root ignore file hides by itself.

    The module docstring argues why this is the question and the decider is
    not. Nothing here reads a pattern: git is asked, in a repository where no
    nested file exists to outrank the root one.

    **A path is asked with a trailing slash where the real tree holds a
    directory**, because `check-ignore` cannot tell that a path it cannot see
    is one, and the scratch repository holds no directories at all. Measured:
    with `/sub/build/` as the only rule, `check-ignore sub/build` answers *not
    ignored* and `check-ignore sub/build/` answers with the rule. A caller
    asking about a directory that need not exist — the regression locks at the
    foot of this file — spells the slash itself, and it is kept rather than
    doubled.
    """
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
    """The non-root ignore file hiding *every* entry of `directory`, or `None`.

    One visible entry is enough to say the tools agree about this directory:
    git can see it, so it is not hidden, whatever the rule does to the rest.
    That is what a sentinel could not establish — a rule matching one name
    says nothing about the others, and both `zz-*` and `*[!zzz]` match some
    names and not others.

    An empty directory returns `None`. There is nothing in it for the index to
    read, so there is no disagreement to report.

    Entries the root file hides are ones the indexer skips too, so they
    cannot raise the finding on their own, and a directory whose every entry
    it reaches is not a disagreement. Reached, not decided: the root file can
    cover an entry that a nested file is still reported as deciding.
    """
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

    **Each directory is asked about twice, and the two questions are not the
    same one.** Whether the *directory* is hidden decides pruning: only a root
    rule covering the directory itself means the indexer agrees and everything
    beneath is covered by construction, which is what keeps `node_modules/`
    out of the walk. Whether *everything in it* is hidden decides the finding,
    because a directory's own `.gitignore` cannot hide the directory — it
    hides the contents.

    Pruning on a sentinel was wrong, and quietly: a root rule can match the
    sentinel's name without covering the directory at all — `zz-*` matches it
    at any depth — so the walk skipped a directory the indexer reads and never
    reached the nested file below it (Copilot, round 7).

    **Raising the finding from a sentinel was wrong in the other direction**,
    and one round later: a *nested* `zz-*` matches it too, and reports a
    directory whose `visible.txt` git can see perfectly well. One name cannot
    establish what a rule does to every other name, which is the same
    enumeration mistake as `BLANKET_PATTERNS` wearing different clothes. The
    finding is decided from the directory's real entries now — every one of
    them hidden, by something other than the root file — so no spelling has to
    be recognised at all (Copilot, round 8).
    """
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
            # instead is the defect the module docstring records: a covered
            # directory a nested template also matches was reported for ever.
            # Either way the subtree is settled and is not descended into.
            if child not in covered:
                # A parent's `.gitignore` or an excludes file hides it, and
                # the indexer reads on.
                findings.append((child, covering))

    walk("")
    return findings


class GitIsReallyBeingAsked(unittest.TestCase):
    """The control on the mechanism every other case here rests on.

    `deciders` returning an empty map for everything would make the live scan
    green and the coverage assertions red in a way that reads as a missing
    rule rather than a broken call, so the call is proved first.
    """

    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, str(self.root), ignore_errors=True)
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

    Each spelling was measured with `git status --ignored=matching` before it
    was written down, and the list is deliberately open-ended — it is evidence
    that enumeration cannot finish, which is the argument for delegating.
    """

    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, str(self.root), ignore_errors=True)
        subprocess.run(["git", "init", "-q"], cwd=str(self.root), check=True,
                       capture_output=True)

    def write(self, relative, text):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8", newline="\n")

    def test_every_blanket_spelling_is_caught(self):
        # `?*` is blueprint-frontend#53's PR round 5, and the reason this file
        # stopped keeping a set of these. Nothing recognises them now — each
        # directory holds two ordinary files and the question is whether git
        # can see either.
        for spelling in ("*", "/*", "**", "/**", "?*", "*?", "?**"):
            with self.subTest(spelling=spelling):
                root = Path(tempfile.mkdtemp())
                self.addCleanup(shutil.rmtree, str(root), ignore_errors=True)
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
        #
        # **This one does not pin the round-7 fix, and saying so is the
        # point.** It was written believing it did, and measured against the
        # probe-only walk it passes there too — hiding a directory hides
        # everything under it, so the probe inside finds the same rule and
        # both readings agree. It stays as cover for the directory-level
        # branch, which nothing else reaches; the case above is the one that
        # discriminates.
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
        # it. `outer` is tracked, so git reads `outer/.gitignore` and names it
        # for `outer/state` although the root file covers that path too — and
        # a gate reading the decider went on reporting a directory its own
        # advice had already fixed. The two assertions are the two questions:
        # git's decider, and the indexer's coverage.
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


class TheSessionStateTreesAreCoveredAtTheRoot(unittest.TestCase):
    """The regression lock for blueprint-frontend#53, and it holds in CI.

    The live scan above cannot carry this on its own: `.remember/` and
    `.superpowers/` are local session state, so a checkout without them scans
    clean whether or not the root rules survived. These ask about paths inside
    them regardless of whether they are there, which is the property the
    earlier version of this file did not have.
    """

    def test_remember_is_covered_by_the_root_file(self):
        decided = deciders(ROOT, [f".remember/{PROBE}"])
        self.assertEqual(ROOT_IGNORE, decided.get(f".remember/{PROBE}"))

    def test_superpowers_is_covered_by_the_root_file(self):
        # Asked at the depth the nested file actually sits at, so the
        # ancestor rule is what has to answer for it.
        decided = deciders(ROOT, [f".superpowers/sdd/{PROBE}"])
        self.assertEqual(ROOT_IGNORE, decided.get(f".superpowers/sdd/{PROBE}"))


class TheNativeGeneratedTreesAreCoveredAtTheRoot(unittest.TestCase):
    """The regression lock for what `cap sync` and Gradle write, and it holds
    in CI.

    The live scan cannot carry this one either, and for the opposite reason to
    the session-state trees above: these directories exist only in a checkout
    that has built, so CI's tree is clean of them and scans green whether or
    not the root rules survive. A developer's checkout is where they appear,
    and a developer's checkout is the only place the index is ever built — the
    measurement that found them is in the root `.gitignore` beside the rules.

    Asked with a trailing slash, because every rule here ends in one and git
    cannot tell that a path it cannot see is a directory.
    """

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
    )

    def test_the_root_file_hides_every_generated_native_tree(self):
        # The whole set in one assertion, so a line dropped from the root
        # file fails here and names itself.
        self.assertEqual(set(self.GENERATED),
                         root_only_hides(ROOT, list(self.GENERATED)))


if __name__ == "__main__":
    unittest.main()
