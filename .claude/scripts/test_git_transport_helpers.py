"""The git transport helpers, and the edit denies `/ship` cannot carry itself.

blueprint-frontend#114 and #115. A permission rule matches the text of a
command, so `Bash(git fetch origin:*)` can pin the remote and cannot pin the
tail, and `Bash(git pull --ff-only)` was only ever meant as the no-argument
form. The helpers here take the place of both grants: the remote is spelled in
the file, the one argument is shape-checked, and no flag has a position to
occupy. The second class is #115's item 1 — the edit denies that make
`npm-checks.sh` safe to run were a command's frontmatter, which holds for the
turn that loaded it, and now also stand in `settings.json`.

Run: py -3.12 -m unittest discover -s .claude/scripts
Needs bash and git on PATH. Every behaviour case drives a real repository.
"""

import json
import os
import re
import shutil
import subprocess
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
CLAUDE = SCRIPTS.parent
COMMANDS = CLAUDE / "commands"
SETTINGS = CLAUDE / "settings.json"
FETCH = SCRIPTS / "git-fetch-origin.sh"
PULL = SCRIPTS / "git-pull-ff-only.sh"

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


def code_lines(path):
    """The executable lines of a script. A scan of the whole file would read
    the comment that explains a refusal as the defect it refuses."""
    return [
        line.strip() for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]


# A remote, a checkout of it on `feat/x`, and a second clone that can move the
# remote underneath it.
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
git clone -q "$root/remote.git" "$root/other"
cd "$root/other"
git config user.email test@example.invalid
git config user.name Test
printf %s "$root"
'''

# Another session pushes one commit to feat/x.
OTHER_PUSHES = '''
cd "$R/other" && git checkout -q feat/x && echo more > c.txt
git add -A && git commit -qm "pushed elsewhere" && git push -q origin feat/x
'''


class AFixture(unittest.TestCase):
    def setUp(self):
        self.root = run_bash(FIXTURE).stdout.strip()
        self.assertTrue(self.root, "the fixture produced no path")
        self.addCleanup(lambda: run_bash('rm -rf "$R"', R=self.root))
        self.work = self.root + "/work"

    def at(self, script):
        return run_bash('cd "$W" && ' + script, W=self.work)

    def other_pushes(self):
        result = run_bash(OTHER_PUSHES, R=self.root)
        self.assertEqual(0, result.returncode, result.stderr)

    def tip(self, ref):
        return self.at(f"git rev-parse {ref}").stdout.strip()


class FetchOriginTakesABranchAndNothingElse(AFixture):

    def fetch(self, *args):
        # The arguments travel in the environment, quoted here, for the reason
        # `run_bash` gives.
        return run_bash('cd "$W" && bash "$H" "${A1-}" ${A2+"$A2"}',
                        W=self.work, H=str(FETCH),
                        **{f"A{i + 1}": a for i, a in enumerate(args)})

    def test_it_fetches_the_branch_it_is_given(self):
        before = self.tip("refs/remotes/origin/feat/x")
        self.other_pushes()
        result = self.fetch("feat/x")
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertNotEqual(before, self.tip("refs/remotes/origin/feat/x"),
                            "the remote-tracking ref moved, so the fetch ran")

    def test_it_takes_exactly_one_argument(self):
        for args in ((), ("feat/x", "extra")):
            with self.subTest(args=args):
                self.assertEqual(2, run_bash(
                    'cd "$W" && bash "$H" ${A1+"$A1"} ${A2+"$A2"}',
                    W=self.work, H=str(FETCH),
                    **{f"A{i + 1}": a for i, a in enumerate(args)}).returncode)

    def test_nothing_that_is_not_a_plain_branch_name_reaches_git(self):
        # Flags, abbreviated flags, a refspec, a transport and a URL: each of
        # these is a position the old prefix grant left open.
        for argument in ("--upload-pack=/tmp/evil", "--upl=/tmp/evil", "-p",
                         "ext::sh -c id", "ext::sh", "+refs/heads/*:refs/heads/*",
                         "feat/x:refs/heads/main", "https://example.invalid/r.git",
                         "a..b", "feat x", "$(id)", "`id`", "a;b", ""):
            with self.subTest(argument=argument):
                result = self.fetch(argument)
                self.assertEqual(2, result.returncode, f"{argument!r}: {result.stderr}")

    def test_the_remote_is_spelled_in_the_file_and_the_only_fetch_is_this_one(self):
        fetches = [line for line in code_lines(FETCH) if "git fetch" in line]
        self.assertEqual(['git fetch origin "$branch"'], fetches)


class PullFfOnlyTakesNoArgumentAndPullsTheCurrentBranch(AFixture):

    def pull(self, *args):
        return run_bash('cd "$W" && bash "$H" ${A1+"$A1"}',
                        W=self.work, H=str(PULL),
                        **{f"A{i + 1}": a for i, a in enumerate(args)})

    def test_it_fast_forwards_from_origin(self):
        self.other_pushes()
        result = self.pull()
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual(self.tip("refs/remotes/origin/feat/x"), self.tip("HEAD"))

    def test_it_takes_no_argument_whatever_it_looks_like(self):
        for argument in ("ext::sh -c id", "--rebase", "--no-ff", "origin", "main", ""):
            with self.subTest(argument=argument):
                result = self.pull(argument)
                self.assertEqual(2, result.returncode, f"{argument!r}: {result.stderr}")

    def test_a_detached_head_is_refused(self):
        self.at("git checkout -q --detach HEAD")
        result = self.pull()
        self.assertEqual(4, result.returncode)
        self.assertIn("detached HEAD", result.stderr)

    def test_a_diverged_branch_is_a_refusal_not_a_merge(self):
        self.other_pushes()
        self.at("echo local > d.txt && git add -A && git commit -qm local")
        local = self.tip("HEAD")
        result = self.pull()
        self.assertNotEqual(0, result.returncode, "a diverged pull must not succeed")
        self.assertEqual(local, self.tip("HEAD"), "no merge commit was made")

    def test_the_only_pull_names_its_remote_and_forbids_a_merge(self):
        pulls = [line for line in code_lines(PULL) if "git pull" in line]
        self.assertEqual(['git pull --ff-only origin "$branch"'], pulls)


class TheCommandsGrantTheHelpersAndNotTheRawForms(unittest.TestCase):

    def frontmatter(self, name):
        return (COMMANDS / name).read_text(encoding="utf-8").split("---")[1]

    # The raw forms are withdrawn in `NoCommandHoldsAPrefixGrantThatAdmitsAForbiddenFlag`,
    # beside the three that came before them; this is what takes their place.
    def test_the_commands_that_used_them_grant_the_helpers(self):
        for command in ("ship.md", "branch.md"):
            with self.subTest(command=command):
                self.assertIn("Bash(bash .claude/scripts/git-fetch-origin.sh:*)",
                              self.frontmatter(command))
        # **Exactly, never by prefix**: the helper takes no argument, and a
        # `:*` would let a `$(…)` tail run before its arity check refused it.
        ship = self.frontmatter("ship.md")
        self.assertIn("Bash(bash .claude/scripts/git-pull-ff-only.sh)", ship)
        self.assertNotIn("git-pull-ff-only.sh:*", ship)


class TheEditDeniesTheChecksRunOnAreInSettingsToo(unittest.TestCase):
    """#115, item 1. `npm-checks.sh` runs `package.json`'s scripts and the
    JavaScript configuration on the host, and `/ship` holds `Write`. The denies
    that stop a session writing what it is then told to run were frontmatter —
    which lasts the turn that loaded it — and are now also in `settings.json`,
    which holds for every turn.
    """

    ALSO_IN_SETTINGS = (
        ".github/**", "package.json", "**/package.json", ".npmrc", "**/.npmrc",
        "angular.json", "tsconfig.json", "tsconfig.app.json", "tsconfig.spec.json",
        "**/tsconfig*.json", "**/*.config.cjs", "**/*.config.mjs", "**/*.config.ts",
        "**/*.config.mts", "node_modules/**",
    )

    def deny(self):
        return json.loads(SETTINGS.read_text(encoding="utf-8"))["permissions"]["deny"]

    def ship_denies(self):
        found = re.findall(r"^disallowed-tools:\s*(.+)$",
                           (COMMANDS / "ship.md").read_text(encoding="utf-8"), re.MULTILINE)
        self.assertEqual(1, len(found))
        return {t.strip() for t in re.split(r",\s*(?=[A-Z][A-Za-z]*\()", found[0])}

    def test_each_is_denied_in_both_spellings(self):
        deny = self.deny()
        for path in self.ALSO_IN_SETTINGS:
            for prefix in ("", "./"):
                if prefix and path.startswith("**"):
                    continue
                with self.subTest(path=path, prefix=prefix):
                    self.assertIn(f"Edit({prefix}{path})", deny)

    def test_each_is_still_in_the_frontmatter_it_came_from(self):
        # The pair is deliberate: the frontmatter is what a command's own turn
        # reads, and a deny that lived only in settings would stop being
        # visible where the command is read.
        ship = self.ship_denies()
        for path in self.ALSO_IN_SETTINGS:
            with self.subTest(path=path):
                self.assertIn(f"Edit({path})", ship)

    def test_the_linters_own_config_is_the_stated_exception(self):
        # `/style-pass` records a corrected form in `eslint.config.js` and
        # `.prettierrc`, and a deny in `settings.json` beats a command's own
        # allowance. So these two stay out of the shared list, and that is a
        # decision rather than an oversight: the residual is stated in
        # `docs/harness-boundaries.md`.
        deny = self.deny()
        for path in ("eslint.config.js", "./eslint.config.js", ".prettierrc",
                     "./.prettierrc", "**/*.config.js"):
            with self.subTest(path=path):
                self.assertNotIn(f"Edit({path})", deny)

    def test_the_rules_are_edit_and_never_write(self):
        for rule in self.deny():
            with self.subTest(rule=rule):
                self.assertFalse(rule.startswith("Write("))



if __name__ == "__main__":
    unittest.main()
