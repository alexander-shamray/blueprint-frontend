"""git-rebase-onto-main.sh: the only force push, and what bounds it.

A permission rule matches the text of a command, so it can pin a flag and
cannot pin a fact about the checkout. Everything that makes this force push
safe is the second kind — the branch is the current one, it is not `main`, and
the remote holds nothing the push would discard — so the script is the
boundary and this suite is what watches it. The first class reads the flags;
the rest run the thing.

Ported from `alexander-shamray/blueprint-backend`, where the helper was built
and reviewed (#57). The module's own harness is spelled here rather than
imported: the suite this repository already runs against its shell helpers,
`test_grok_helpers.py`, carries its own `run_bash` and `code_lines` and argues
for both, and a shared module introduced for one port would be a second
spelling of what exists three files over. The other suites here need neither,
which is why there is nothing to share yet rather than something being
duplicated.

Run: py -3.12 -m unittest discover -s .claude/scripts
Needs bash and git on PATH, and nothing else: every case here drives a real
repository, and none of them parses JSON or matches a declared pattern.
"""

import os
import re
import shutil
import subprocess
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
HELPER = SCRIPTS / "git-rebase-onto-main.sh"

# The fixtures must answer for the script, not for whoever is running them.
# `run_bash` hands the child its own environment, so without this the
# developer's global gitconfig is live inside every fixture repository — and
# one of the cases below exists to prove that configuration cannot change what
# the replay does, which it cannot establish while it inherits some. A path
# that does not exist reads as an empty config file on every platform, where
# `/dev/null` is a spelling only some of them have.
NO_CONFIG = str(SCRIPTS / "no-such-gitconfig-for-the-fixtures")

BASH = shutil.which("bash")
GIT = shutil.which("git")


def setUpModule():
    # Not a skip. A skip on a missing tool reports a pass, which is the
    # fail-open every gate in this repository is written against. Absent
    # either of these, this suite has established nothing and says so.
    missing = [name for name, path in (("bash", BASH), ("git", GIT)) if path is None]
    if missing:
        raise RuntimeError(
            f"{', '.join(missing)} required and not on PATH: these tests exercise "
            "the same tools the script does, and asserting through Python "
            "equivalents instead would be testing a second specification"
        )


def run_bash(script, subject="", **env_extra):
    """Run a bash fragment with the subject on stdin and everything else in env.

    Nothing is passed as an argument: under MSYS — the host this repository is
    developed on — an argv element crossing into `bash.exe` is re-parsed by the
    MSYS runtime, so a path or a pattern arrives mangled and the case silently
    tests something else. Environment variables and stdin are not re-parsed, so
    they mean the same thing on both platforms.
    """
    env = dict(os.environ)
    env.setdefault("GIT_CONFIG_GLOBAL", NO_CONFIG)
    env.setdefault("GIT_CONFIG_SYSTEM", NO_CONFIG)
    env.update(env_extra)
    return subprocess.run(
        [BASH, "-c", script],
        input=subject,
        capture_output=True,
        text=True,
        env=env,
    )


def code_lines(text):
    """The executable lines of a shell script — comments and blanks dropped.

    An assertion that a line exists, made against the whole file, passes on a
    comment that mentions it, so deleting the executable line would not fail
    it. This helper names the flags it refuses, in the comments explaining
    why, which makes a whole-file scan read the explanation as the defect.
    """
    return [
        line for line in text.splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]


# A remote, a checkout of it, a branch with one commit, and a `main` that has
# moved since — the state every branch update starts from.
FIXTURE = '''
set -eu
root=$(mktemp -d)
git init -q --bare --initial-branch=main "$root/remote.git"
git init -q --initial-branch=main "$root/work"
cd "$root/work"
git config user.email test@example.invalid
git config user.name Test
git remote add origin "$root/remote.git"
echo base > a.txt && git add -A && git commit -qm "the base"
git push -q -u origin main
git checkout -qb feat/x
echo work > b.txt && git add -A && git commit -qm "the branch work"
git push -q -u origin feat/x
git checkout -q main
echo moved > c.txt && git add -A && git commit -qm "main moved"
git push -q origin main
git checkout -q feat/x
printf %s "$root"
'''

# Both sides edit the same line, so the replay cannot proceed without a person.
CONFLICT = '''
git checkout -q main && echo mine > a.txt && git add -A
git commit -qm "main edits a.txt" && git push -q origin main
git checkout -q feat/x && echo theirs > a.txt && git add -A
git commit -qm "the branch edits a.txt" && git push -q origin feat/x
'''


class TheFlagsAreTheScriptsOwn(unittest.TestCase):
    """The grant buys `bash <this file>`, so the flags are never a caller's to
    choose. A prefix rule cannot exclude a trailing flag, which is why this
    repository answers such cases with a helper (`docs/harness-boundaries.md`).
    """

    # The executable lines only. An assertion made against the whole file
    # passes on a comment that mentions the guard, so deleting the guard would
    # not fail it — which is `code_lines`' own argument.
    source = "\n".join(code_lines(HELPER.read_text(encoding="utf-8")))

    # A command may be written with the environment in front of it, and this
    # file already writes one that way — `GIT_EDITOR=true git rebase
    # --continue`. Both scans below decide what to look at by how the line
    # STARTS, so without this a second push spelled `GIT_SSH_COMMAND=… git push
    # --force …` is invisible to both of them: it never enters the push list,
    # so the count still reads one, and it never enters the command text, so
    # the force scan still reads clean. A gate that stops covering the newest
    # spelling is the failure this repository records most often, and this is
    # that gate.
    LEADING_ENV = re.compile(r"^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+|env\s+|command\s+)*")

    @classmethod
    def commands(cls, prefix):
        found = []
        for line in cls.source.splitlines():
            bare = cls.LEADING_ENV.sub("", line.strip())
            if bare.startswith(prefix):
                found.append(bare)
        return found

    def test_there_is_exactly_one_push_and_it_carries_an_expected_value(self):
        self.assertEqual(
            self.commands("git push"),
            ['git push --force-with-lease="$branch:$lease" origin "$branch"'],
            "one push, leased against the commit this run read, naming its remote and its refspec")

    def test_the_scan_sees_a_command_written_behind_its_environment(self):
        # The positive control for the stripping above, and it is not
        # hypothetical: the helper's own `git rebase --continue` is written
        # that way, so a scan that missed the form would miss a real line.
        self.assertIn("git rebase --continue",
                      " ".join(self.commands("git rebase")),
                      "a `NAME=value git …` line must reach the scans")

    def test_no_spelling_of_the_unleased_force_appears(self):
        # The commands only. Scanning the whole file catches `[ -f "$state/… ]`
        # and every prose mention of the deny this helper exists beside, which
        # is a check that fails on its own documentation.
        commands = "\n".join(self.commands("git "))
        for spelling in ("--force ", "--force\n", "--force=", " -f ", "--force-if-includes"):
            self.assertNotIn(spelling, commands, f"{spelling!r} would discard without a lease")

    def test_the_push_leases_against_the_value_the_guard_approved(self):
        # Re-reading the remote ref in `publish` would lease against whatever a
        # fetch had since made of it, with the whole replay in between — the
        # lease would then name the commits the guard refused.
        self.assertIn('lease="$approved_lease"', self.source)
        self.assertEqual(
            1, self.source.count('approved_lease=$(git rev-parse "refs/remotes/origin/$branch")'),
            "one place reads the remote tip into a lease, and it is the guard")
        for line in self.source.splitlines():
            self.assertNotRegex(line.strip(), r'^lease=\$\(git rev-parse',
                                "a lease built from a fresh read names whatever a fetch has since made of it")


class TheHelperRefusesBeforeItRewrites(unittest.TestCase):

    def setUp(self):
        self.root = run_bash(FIXTURE).stdout.strip()
        self.assertTrue(self.root, "the fixture produced no path")
        self.addCleanup(lambda: run_bash('rm -rf "$R"', R=self.root))
        self.work = self.root + "/work"

    def helper(self, branch, mode="start"):
        return run_bash('cd "$W" && bash "$H" "$B" "$M"',
                        W=self.work, H=str(HELPER), B=branch, M=mode)

    def at(self, script):
        return run_bash('cd "$W" && ' + script, W=self.work)

    def head(self):
        return self.at("git rev-parse HEAD").stdout.strip()

    def test_it_takes_a_branch_and_a_mode(self):
        one = run_bash('cd "$W" && bash "$H" feat/x', W=self.work, H=str(HELPER))
        self.assertEqual(2, one.returncode)
        self.assertEqual(2, self.helper("feat/x", "land").returncode, "an unknown mode is refused")

    def test_main_is_refused_even_while_main_is_checked_out(self):
        self.at("git checkout -q main")
        self.assertEqual(3, self.helper("main").returncode)

    def test_main_is_refused_however_it_is_spelled(self):
        # One string compare is one spelling, and this host's filesystem is
        # case-insensitive: `git branch Main` answers that it already exists.
        for spelling in ("main", "Main", "MAIN", "heads/main", "refs/heads/main",
                         "origin/main", "refs/remotes/origin/main"):
            result = self.helper(spelling)
            self.assertEqual(3, result.returncode, f"{spelling!r}: {result.stderr}")

    def test_naming_another_branch_does_not_act_on_it(self):
        # The guard is the refusal, not the exit code: `publish` exits 4 as
        # well, and would have rebased the other branch on the way there.
        self.at("git checkout -qb feat/other")
        other_before = self.at("git rev-parse feat/other").stdout.strip()
        result = self.helper("feat/x")
        self.assertEqual(4, result.returncode)
        self.assertIn("only ever touches the current branch", result.stderr)
        self.assertEqual(other_before, self.at("git rev-parse feat/other").stdout.strip(),
                         "the branch in hand was replayed on the way to the refusal")

    def test_a_detached_head_is_refused(self):
        self.at("git checkout -q --detach HEAD")
        result = self.helper("feat/x")
        self.assertEqual(4, result.returncode)
        self.assertIn("detached HEAD", result.stderr,
                      "the equality check below exits 4 too, so the code alone proves nothing")

    def test_a_dirty_tree_is_refused(self):
        self.at("echo uncommitted >> b.txt")
        self.assertEqual(5, self.helper("feat/x").returncode)
        self.assertIn("uncommitted", self.at("cat b.txt").stdout, "the edit survives the refusal")

    def test_a_branch_the_remote_does_not_have_is_refused(self):
        # Exit 6 has two sources — no `origin/main` to rebase onto, and no
        # `origin/<branch>` to push over — so the code alone does not say
        # which guard fired, and a regression into the neighbouring one would
        # leave this green.
        self.at("git checkout -qb feat/unpublished")
        result = self.helper("feat/unpublished")
        self.assertEqual(6, result.returncode)
        self.assertIn("origin has no feat/unpublished", result.stderr)

    def test_commits_only_the_remote_has_stop_it(self):
        # A lease is satisfied by a commit this checkout has fetched, so it
        # would not stop a push that knowingly discards another session's work.
        # This is the guard that does.
        self.at('git clone -q ../remote.git ../second')
        run_bash('cd "$R/second" && git config user.email t@e.invalid && git config user.name T '
                 '&& git checkout -q feat/x && echo theirs > theirs.txt && git add -A '
                 '&& git commit -qm "another session" && git push -q origin feat/x', R=self.root)
        self.assertEqual(7, self.helper("feat/x").returncode)

    def test_continue_and_abort_refuse_when_no_rebase_is_running(self):
        # Exit 9 has six sources in this script, so each case that ends on it
        # names the one it means. Without that, a guard regressing into a
        # neighbouring refusal keeps every one of them green.
        cont = self.helper("feat/x", "continue")
        self.assertEqual(9, cont.returncode)
        self.assertIn("'continue' has nothing to finish", cont.stderr)
        abort = self.helper("feat/x", "abort")
        self.assertEqual(9, abort.returncode)
        self.assertIn("'abort' has nothing to undo", abort.stderr)

    def test_a_rebase_that_never_started_leaves_no_record_behind(self):
        # The lease is recorded BEFORE the replay so it survives a failed
        # push; a replay that never happens must not leave that record lying
        # there. Left behind, it refuses the next `start` — "a replay is
        # waiting to be published" — about a branch git never touched, and
        # hands `publish` a lease approved for a rebase that did not run.
        self.at('printf "#!/bin/sh\\nexit 1\\n" > "$(git rev-parse --git-path hooks)/pre-rebase" '
                '&& chmod +x "$(git rev-parse --git-path hooks)/pre-rebase"')
        self.assertEqual(11, self.helper("feat/x").returncode)
        self.assertEqual(
            "absent",
            self.at('test -f "$(git rev-parse --git-path claude-rebase-pending)" '
                    '&& echo present || echo absent').stdout.strip())

        self.at('rm -f "$(git rev-parse --git-path hooks)/pre-rebase"')
        again = self.helper("feat/x")
        self.assertEqual(0, again.returncode, again.stderr)

    def test_a_rebase_this_helper_did_not_start_is_not_published(self):
        # An interactive rebase dropping the branch's commits passes every
        # other check in `continue`: the published tip is what it started
        # from, so the divergence guard is satisfied and the result — which
        # holds none of the branch's work — would be forced over it.
        #
        # git runs `GIT_SEQUENCE_EDITOR` through a shell with the todo path
        # appended, so a redirection is the portable way to write one. `sed -i
        # <script>` is not: BSD sed reads the script as the backup suffix, so
        # on macOS the editor fails, the rebase never starts, and the case goes
        # green for the wrong reason — `continue` refusing a rebase that is not
        # there rather than one this helper did not start. The source
        # repository never met that, because its matrix job runs two modules
        # and its full suite runs on ubuntu alone; this repository's `harness`
        # job runs the whole discover on all three platforms, which is what
        # caught it.
        published = self.at("git rev-parse refs/remotes/origin/feat/x").stdout.strip()
        self.at('GIT_SEQUENCE_EDITOR="echo break >" '
                'git rebase -i refs/remotes/origin/main')
        result = self.helper("feat/x", "continue")
        self.assertEqual(9, result.returncode, result.stderr)
        self.assertIn("not started by this helper", result.stderr)
        self.assertEqual(published, self.at("git rev-parse refs/remotes/origin/feat/x").stdout.strip(),
                         "the remote still carries the branch's published work")
        self.at("git rebase --abort")

    def test_a_rebase_that_never_started_is_not_called_a_conflict(self):
        # Every other way `git rebase` can fail leaves no state, and reporting
        # it as a conflict sends the caller to a `continue` with nothing to do.
        self.at('printf "#!/bin/sh\\nexit 1\\n" > "$(git rev-parse --git-path hooks)/pre-rebase" '
                '&& chmod +x "$(git rev-parse --git-path hooks)/pre-rebase"')
        result = self.helper("feat/x")
        self.assertEqual(11, result.returncode, result.stderr)
        self.assertIn("did not start", result.stderr)


class AConflictIsTheCaseRebaseIsHereFor(unittest.TestCase):
    """The resolution belongs in the replayed commit, not in a merge commit.

    So `start` leaves a conflicted rebase in progress rather than aborting it:
    backing out would send the caller to the merge this repository stopped
    making, and the tree would stop being a line.
    """

    def setUp(self):
        self.root = run_bash(FIXTURE).stdout.strip()
        self.addCleanup(lambda: run_bash('rm -rf "$R"', R=self.root))
        self.work = self.root + "/work"
        self.at(CONFLICT)

    def at(self, script):
        return run_bash('cd "$W" && ' + script, W=self.work)

    def helper(self, mode, branch="feat/x"):
        return run_bash('cd "$W" && bash "$H" "$B" "$M"',
                        W=self.work, H=str(HELPER), B=branch, M=mode)

    def rebase_running(self):
        return self.at('test -d "$(git rev-parse --git-path rebase-merge)" '
                       '-o -d "$(git rev-parse --git-path rebase-apply)" '
                       '&& echo yes || echo no').stdout.strip()

    def test_a_conflict_leaves_the_rebase_in_progress_and_names_the_paths(self):
        result = self.helper("start")
        self.assertEqual(8, result.returncode)
        self.assertIn("a.txt", result.stderr, "the caller is told what to resolve")
        self.assertEqual("yes", self.rebase_running(), "aborting here would mean a merge instead")

    def test_continue_refuses_while_anything_is_still_unmerged(self):
        self.assertEqual(8, self.helper("start").returncode)
        self.assertEqual(9, self.helper("continue").returncode, "nothing was resolved")
        self.assertEqual("yes", self.rebase_running())

    def test_resolving_and_continuing_publishes_a_line(self):
        self.assertEqual(8, self.helper("start").returncode)
        self.at('echo resolved > a.txt && git add a.txt')
        result = self.helper("continue")
        self.assertEqual(0, result.returncode, result.stderr)

        self.assertEqual("no", self.rebase_running())
        self.assertEqual("resolved\n", self.at("cat a.txt").stdout,
                         "the resolution is in the replayed commit")
        self.assertEqual("", self.at("git log --merges --format=%H origin/main..HEAD").stdout,
                         "and no merge commit was made — the whole point")
        self.assertEqual(self.at("git rev-parse HEAD").stdout.strip(),
                         self.at("git rev-parse refs/remotes/origin/feat/x").stdout.strip(),
                         "the remote carries what was replayed")

    def test_continue_fails_closed_when_the_starting_commit_is_unreadable(self):
        # The lease alone would not stop this: another session's commits that
        # this checkout has fetched satisfy it. Skipping the check that does
        # would leave the only force push in the repository unguarded.
        self.assertEqual(8, self.helper("start").returncode)
        self.at('rm -f "$(git rev-parse --git-path rebase-merge)"/orig-head '
                '"$(git rev-parse --git-path rebase-merge)"/head')
        self.at('echo resolved > a.txt && git add a.txt')
        result = self.helper("continue")
        self.assertEqual(9, result.returncode, result.stderr)
        self.assertIn("divergence", result.stderr)

    def test_abort_puts_the_branch_back_and_publishes_nothing(self):
        before = self.at("git rev-parse HEAD").stdout.strip()
        remote_before = self.at("git rev-parse refs/remotes/origin/feat/x").stdout.strip()
        self.assertEqual(8, self.helper("start").returncode)
        self.assertEqual(0, self.helper("abort").returncode)

        self.assertEqual("no", self.rebase_running())
        self.assertEqual(before, self.at("git rev-parse HEAD").stdout.strip())
        self.assertEqual(remote_before, self.at("git rev-parse refs/remotes/origin/feat/x").stdout.strip())


class ALegacyMergeForwardIsNotSilentlyDropped(unittest.TestCase):
    """A rebase drops merge commits, and a branch made under the old policy
    has one. Where that merge carries content neither parent has, replaying
    loses it before the push, which no lease can see."""

    def setUp(self):
        self.root = run_bash(FIXTURE).stdout.strip()
        self.addCleanup(lambda: run_bash('rm -rf "$R"', R=self.root))
        self.work = self.root + "/work"

    def at(self, script):
        return run_bash('cd "$W" && ' + script, W=self.work)

    def helper(self, mode="start", branch="feat/x"):
        return run_bash('cd "$W" && bash "$H" "$B" "$M"',
                        W=self.work, H=str(HELPER), B=branch, M=mode)

    def merge_forward(self):
        self.at('git checkout -q main && echo later > d.txt && git add -A '
                '&& git commit -qm "main moved again" && git push -q origin main '
                '&& git checkout -q feat/x && git merge --no-edit -q main')

    def test_a_merge_carrying_its_own_content_stops_the_run(self):
        self.merge_forward()
        self.at('echo only-here > resolved-by-hand.txt && git add -A '
                '&& git commit -q --amend --no-edit && git push -q -f origin feat/x')
        before = self.at("git rev-parse HEAD").stdout.strip()

        result = self.helper()
        self.assertEqual(10, result.returncode, result.stderr)
        self.assertEqual(before, self.at("git rev-parse HEAD").stdout.strip(), "nothing was replayed")
        self.assertEqual("only-here\n", self.at("cat resolved-by-hand.txt").stdout)

    def test_an_ordinary_merge_forward_is_flattened_without_complaint(self):
        # Its content is in its parents, so dropping it loses nothing.
        self.merge_forward()
        self.at('git push -q -f origin feat/x')
        result = self.helper()
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual("", self.at("git log --merges --format=%H origin/main..HEAD").stdout,
                         "the merge is gone and the branch is a line")


class TheHelperPublishesWhatItRebased(unittest.TestCase):

    def setUp(self):
        self.root = run_bash(FIXTURE).stdout.strip()
        self.addCleanup(lambda: run_bash('rm -rf "$R"', R=self.root))
        self.work = self.root + "/work"

    def at(self, script):
        return run_bash('cd "$W" && ' + script, W=self.work)

    def helper(self, mode="start", branch="feat/x"):
        return run_bash('cd "$W" && bash "$H" "$B" "$M"',
                        W=self.work, H=str(HELPER), B=branch, M=mode)

    def test_a_clean_update_is_replayed_and_published(self):
        before = self.at("git rev-parse HEAD").stdout.strip()
        result = self.helper()
        self.assertEqual(0, result.returncode, result.stderr)

        after = self.at("git rev-parse HEAD").stdout.strip()
        self.assertNotEqual(before, after, "a replay onto a moved base makes new SHAs")
        self.assertEqual("", self.at("git log --merges --format=%H origin/main..HEAD").stdout,
                         "a rebased branch carries no merge commit")
        self.assertEqual(after, self.at("git rev-parse refs/remotes/origin/feat/x").stdout.strip())
        self.assertEqual("", self.at("git log --oneline HEAD..origin/main").stdout,
                         "and the branch now holds everything main does")

    def test_configuration_cannot_change_what_the_replay_does(self):
        # Every setting here is the caller's, and each breaks a stated
        # guarantee: `rebaseMerges` keeps the merge commits this helper exists
        # to be rid of, `updateRefs` force-updates other local branches' refs
        # as a side effect, and `autoSquash` silently recombines a `fixup!`
        # into the commit it names — and the result of all three is force
        # pushed.
        #
        # **`updateRefs` needs a ref pointing INTO the replayed range to do
        # anything**, and the fixture had none, so the case passed whether or
        # not the script spelled `--no-update-refs`: the flag could be deleted
        # and nothing here would go red. `side/marker` is that ref.
        self.at("git config rebase.rebaseMerges true && git config rebase.updateRefs true "
                "&& git config rebase.autoSquash true")
        self.at("git branch side/marker feat/x")
        marker = self.at("git rev-parse side/marker").stdout.strip()
        self.at('echo squashed > e.txt && git add -A '
                '&& git commit -qm "fixup! the branch work"')
        self.at('git checkout -q main && echo later > d.txt && git add -A '
                '&& git commit -qm "main moved again" && git push -q origin main '
                '&& git checkout -q feat/x && git merge --no-edit -q main '
                '&& git push -q -f origin feat/x')
        before = self.at("git log --format=%s origin/main..HEAD --no-merges").stdout

        self.assertEqual(0, self.helper().returncode)
        self.assertEqual("", self.at("git log --merges --format=%H origin/main..HEAD").stdout,
                         "rebase.rebaseMerges would have kept the merge")
        self.assertEqual(marker, self.at("git rev-parse side/marker").stdout.strip(),
                         "rebase.updateRefs would have moved a ref the caller never named")
        self.assertIn("fixup! the branch work",
                      self.at("git log --format=%s origin/main..HEAD").stdout,
                      "rebase.autoSquash would have folded the fixup away")
        self.assertEqual(
            sorted(before.split("\n")),
            sorted(self.at("git log --format=%s origin/main..HEAD --no-merges").stdout.split("\n")),
            "the replay published a different set of commits than the branch had")

    def test_a_push_that_fails_leaves_a_retry_that_works(self):
        # The replay finishes and the push does not, taking the rebase state
        # with it: `start` then reads the rewritten tip as non-ancestral and
        # `continue` finds no rebase, so without the record nothing can reach
        # the branch again.
        # A `pre-push` hook, because the fetch has to succeed for the replay to
        # happen at all — a broken remote fails earlier and proves nothing.
        hooks = 'h="$(git rev-parse --git-path hooks)"; mkdir -p "$h"'
        self.at(hooks + '; printf "#!/bin/sh\\nexit 1\\n" > "$h/pre-push"; chmod +x "$h/pre-push"')
        self.assertNotEqual(0, self.helper().returncode, "the push must fail for this to mean anything")
        rewritten = self.at("git rev-parse HEAD").stdout.strip()
        self.assertEqual("", self.at("git log --oneline HEAD..origin/main").stdout,
                         "the replay did finish; only the push did not")

        blocked = self.helper("start")
        self.assertEqual(9, blocked.returncode, "start refuses while a replay waits")
        self.assertIn("waiting to be published", blocked.stderr)
        self.at(hooks + '; rm -f "$h/pre-push"')
        result = self.helper("publish")
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual(rewritten, self.at("git rev-parse refs/remotes/origin/feat/x").stdout.strip())

    def failed_push(self):
        """Leave the branch replayed, unpublished, and a record waiting."""
        hooks = 'h="$(git rev-parse --git-path hooks)"; mkdir -p "$h"'
        self.at(hooks + '; printf "#!/bin/sh\\nexit 1\\n" > "$h/pre-push"; chmod +x "$h/pre-push"')
        self.assertNotEqual(0, self.helper().returncode, "the push must fail for this to mean anything")
        self.at(hooks + '; rm -f "$h/pre-push"')

    def test_publish_refuses_a_head_that_is_not_what_the_replay_produced(self):
        # `continue` refuses a rebase this helper did not start, and by the
        # time `publish` runs the rebase state is gone, so the recorded head is
        # the only thing left that says HEAD is the replay's work rather than
        # somebody's. Without it the retry forces a hand-rewritten head over
        # the branch's published commits with every other guard green.
        self.failed_push()
        published = self.at("git rev-parse refs/remotes/origin/feat/x").stdout.strip()
        self.at("git reset --hard -q HEAD~1")

        result = self.helper("publish")
        self.assertEqual(9, result.returncode, result.stderr)
        self.assertIn("no longer the commit that replay produced", result.stderr)
        self.assertEqual(published, self.at("git rev-parse refs/remotes/origin/feat/x").stdout.strip(),
                         "the branch's published work was forced over")

    def test_abort_refuses_to_strand_a_replay_that_only_failed_to_push(self):
        # In this state the branch IS the rewritten history and the remote
        # holds what it replaced, so there is nothing to put back. Clearing
        # the record strands it: `start` reads the rewritten tip as
        # non-ancestral, `continue` finds no rebase, and the raw force push
        # that would recover it is denied.
        self.failed_push()
        rewritten = self.at("git rev-parse HEAD").stdout.strip()

        result = self.helper("abort")
        self.assertEqual(9, result.returncode, result.stderr)
        self.assertIn("already rewrote", result.stderr)
        self.assertEqual(
            "present",
            self.at('test -f "$(git rev-parse --git-path claude-rebase-pending)" '
                    '&& echo present || echo absent').stdout.strip(),
            "the record is the only route left and abort deleted it")

        retry = self.helper("publish")
        self.assertEqual(0, retry.returncode, retry.stderr)
        self.assertEqual(rewritten, self.at("git rev-parse refs/remotes/origin/feat/x").stdout.strip())

    def test_abort_will_not_clear_a_record_belonging_to_another_branch(self):
        # The record is per git directory, not per branch, and every other arm
        # compares it to the branch it was given. This one did not, so
        # `abort feat/other` destroyed feat/x's only recovery record and
        # reported that feat/other had been cleared.
        self.failed_push()
        self.at("git checkout -qb feat/other")

        result = self.helper("abort", branch="feat/other")
        self.assertEqual(4, result.returncode, result.stderr)
        self.assertIn("the waiting replay is feat/x", result.stderr)
        self.assertEqual(
            "present",
            self.at('test -f "$(git rev-parse --git-path claude-rebase-pending)" '
                    '&& echo present || echo absent').stdout.strip())

    def test_a_second_run_changes_nothing_and_does_not_force(self):
        self.assertEqual(0, self.helper().returncode)
        settled = self.at("git rev-parse HEAD").stdout.strip()
        again = self.helper()
        self.assertEqual(0, again.returncode, again.stderr)
        self.assertIn("nothing to force", again.stdout)
        self.assertEqual(settled, self.at("git rev-parse HEAD").stdout.strip())


if __name__ == "__main__":
    unittest.main()
