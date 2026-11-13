"""Frontend's npm cases: the check runner and the grants it replaced.

`docs/harness-local.md` *Ship checks* names it. Needs bash and git on PATH.
Run: py -3.12 -m unittest discover -s .claude/scripts -p 'test_npm_checks.py'
"""

import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
COMMANDS = SCRIPTS.parent / "commands"
BASH = shutil.which("bash")
GIT = shutil.which("git")

# The programs no command may be granted in any spelling: package runners and
# interpreters, each of which executes whatever it is pointed at, and the
# wrappers that run whichever program follows them.
FORBIDDEN_PROGRAMS = frozenset({
    "npm", "npx", "node", "ng", "yarn", "pnpm", "bun", "deno",
    "python", "pip", "env", "command", "exec",
})
WRAPPERS = frozenset({"env", "command", "exec"})
# The suffixes Windows runs a program by: npm installs `npx.cmd` beside `npx`.
SHIM_SUFFIXES = (".exe", ".cmd", ".bat", ".ps1")
# `py` is the launcher `.harness/agent-rules.md` requires, so it is granted,
# but only pinned to a script under `.claude/scripts/`, followed by nothing
# or by fixed lower-case subcommand words and then long flags: never a
# short flag, a flag's value, a path or a script.
PINNED_PY = re.compile(
    r"py -3\.\d+ \.claude/scripts/[\w.-]+\.py(?: [a-z][a-z-]*)*(?: --[a-z][a-z-]*)*(?::\*)?")


def program_word(grant):
    """The program a `Bash(...)` grant runs: `npx` for `npx:*`, `NPX.exe:*`,
    `npx.cmd:*`, `/usr/bin/npx:*`, `CI=1 npx:*` and `env npx:*`; `python` for
    `python3.12:*`. A colon before a slash is a drive letter; a wrapper with a
    flag or nothing after it is its own word, since a flag's argument would
    read as the program."""
    rest = grant.strip()
    while True:
        rest = re.sub(r"^(?:\w+=\S*\s+)*", "", rest)
        word = re.split(r"\s|:(?![\\/])|\*", rest, maxsplit=1)[0]
        word = word.replace("\\", "/").rsplit("/", 1)[-1].lower()
        for suffix in SHIM_SUFFIXES:
            if word.endswith(suffix):
                word = word[:-len(suffix)]
                break
        word = re.sub(r"(?<=[a-z])\d+(?:\.\d+)*$", "", word)
        after = re.sub(r"^\S+\s+", "", rest, count=1)
        if word in WRAPPERS and after != rest and after and not after.startswith("-"):
            rest = after
            continue
        return word


def refused_grant(grant):
    """Whether a `Bash(...)` grant runs a package runner or an interpreter."""
    word = program_word(grant)
    if word == "py":
        return not PINNED_PY.fullmatch(grant.strip())
    return word in FORBIDDEN_PROGRAMS


def setUpModule():
    # Not a skip: a skip on a missing tool reports a pass, which is the
    # fail-open this suite exists to refuse (docs/testing.md).
    missing = [name for name, path in (("bash", BASH), ("git", GIT)) if not path]
    if missing:
        raise RuntimeError(f"the npm cases need {', '.join(missing)} on PATH")


class TheCheckRunnerIsTheOnlyExecutor(unittest.TestCase):
    def test_no_command_grants_a_free_form_package_runner(self):
        # A package runner or an interpreter executes whatever it is pointed
        # at, so the executor is `npm-checks.sh`, one closed-set word
        # (docs/harness-local.md, *Residuals*). Every command is read, the
        # payload's included, and each grant is judged by its program word.
        seen = grants = 0
        for path in sorted(COMMANDS.glob("*.md")):
            seen += 1
            text = path.read_text(encoding="utf-8")
            for line in re.findall(r"^allowed-tools:\s*(.+)$", text, re.MULTILINE):
                for grant in re.findall(r"Bash\(([^)]*)\)", line):
                    grants += 1
                    with self.subTest(command=path.name, grant=grant):
                        self.assertFalse(
                            refused_grant(grant),
                            f"{path.name} grants `Bash({grant})`, which runs a "
                            "package runner or an interpreter")
        # The positive controls: an empty glob, or a parser that found no
        # grant, would satisfy every case above.
        self.assertGreater(seen, 3, "found almost no commands")
        self.assertGreater(grants, 20, "found almost no grants")

    def test_a_package_runner_grant_is_refused_in_every_spelling(self):
        # All but `npx *` and `npm run:*` passed the spaced-prefix check this
        # replaced; those two it caught, and the word match must still.
        for grant in ("npx:*", "npx", "npx *", "node:*", "npm:*", "npm run:*",
                      "ng:*", "yarn:*", "pnpm:*", "NODE.EXE:*", "CI=1 npx:*",
                      "/usr/bin/node:*", "C:\\Python\\python.exe:*", "python:*",
                      "python3 -c:*", "pip install:*", "py:*", "py",
                      "py -3.12:*", "py -3.12 -c:*", "py -3.12 /tmp/x.py:*",
                      "py -3.12 -m unittest discover:*",
                      "py -3.12 .claude/scripts/sync_pr.py -c:*",
                      "py -3.12 .claude/scripts/sync_pr.py tasks -x:*",
                      "py -3.12 .claude/scripts/sync_pr.py /tmp/x.py:*",
                      "py -3.12 .claude/scripts/sync_pr.py tasks x.py:*",
                      "py -3.12 .claude/scripts/a.py .claude/scripts/b.py:*",
                      "py -3.12 .claude/scripts/sync_pr.py *",
                      "py -3.12 .claude/scripts/shard-harness-suite.py --x=1",
                      "py -3.12 .claude/scripts/shard-harness-suite.py --",
                      "py -3.12 .claude/scripts/shard-harness-suite.py ---x",
                      "py -3.12 .claude/scripts/shard-harness-suite.py --x /tmp/x.py",
                      "py -3.12 .claude/scripts/shard-harness-suite.py --ids ids",
                      "py -3.12 .claude/scripts/shard-harness-suite.py --x y",
                      "npx.cmd:*", "npm.cmd run:*", "ng.bat:*", "node.ps1:*",
                      "python3.12:*", "pip3.12 install:*", "env npx:*",
                      "env -i node:*", "env FOO=1 npx:*", "command npx:*",
                      "exec python:*", "env:*", "env -i:*",
                      "env -u VAR npx:*", "exec -a x npx:*"):
            with self.subTest(grant=grant):
                self.assertTrue(refused_grant(grant))
        # And the grants the commands do hold, which a word match must spare.
        for grant in ("bash .claude/scripts/npm-checks.sh:*",
                      "py -3.12 .claude/scripts/sync_pr.py:*",
                      "py -3.12 .claude/scripts/dispatch_board.py tasks start:*",
                      "py -3.12 .claude/scripts/dispatch_board.py tasks back:*",
                      "py -3.12 .claude/scripts/shard-harness-suite.py --selective",
                      "git diff:*",
                      "gh pr checks:*", "ls:*"):
            with self.subTest(grant=grant):
                self.assertFalse(refused_grant(grant))

    def test_the_check_runner_helper_takes_no_free_parameter(self):
        # The script names and the flags are literals, and the one argument is
        # matched against a fixed case rather than passed on.
        source = (SCRIPTS / "npm-checks.sh").read_text(encoding="utf-8")
        self.assertIn("npm run lint", source)
        self.assertIn("npm test", source)
        self.assertIn("npm run build", source)
        self.assertNotIn('"$@"', source)
        self.assertNotIn("$mode\"", source.replace('"$mode" in', ""))

    def test_the_check_runner_refuses_an_absent_install(self):
        # Driven, not grepped. A worktree under .claude/worktrees/ resolves
        # packages from the main checkout's node_modules when it has none of
        # its own, so without this refusal every mode would pass against main.
        # The refusal stops before the mode is read, so npm never runs.
        holder = tempfile.TemporaryDirectory(prefix="npm-checks-")
        self.addCleanup(holder.cleanup)
        base = Path(holder.name)
        subprocess.run([GIT, "init", "-q", str(base)], check=True)
        (base / "package-lock.json").write_text("{}\n", encoding="utf-8")
        out = subprocess.run([BASH, str(SCRIPTS / "npm-checks.sh"), "lint"],
                             capture_output=True, text=True, cwd=str(base))
        self.assertEqual(3, out.returncode, out.stderr)
        self.assertIn("no node_modules", out.stderr)
        # No staleness test: a lockfile rewritten with identical content by a
        # checkout that passed through another one is newer than a correct
        # install, so an mtime comparison refused it.
        source = (SCRIPTS / "npm-checks.sh").read_text(encoding="utf-8")
        self.assertNotIn("-nt package-lock.json", source)

    def test_the_check_runner_offers_no_e2e_mode(self):
        # Playwright needs a browser download and the backend's Compose stack.
        # A mode that ran it where neither exists would pass because nothing
        # was listening, which is the fail-open shape every gate here is
        # written against. CI owns that suite.
        source = (SCRIPTS / "npm-checks.sh").read_text(encoding="utf-8")
        self.assertNotIn("npm run e2e", source)


class TheCheckRunnerRecordsItsTime(unittest.TestCase):
    """Driven against a stub `npm` in a scratch repository, so no real check runs."""

    def scratch(self, npm_exit, timings, stubs=None):
        """A scratch repository and the environment of a run in it. `stubs` maps
        more program names to the exit each stands for, first on PATH."""
        holder = tempfile.TemporaryDirectory(prefix="npm-checks-")
        self.addCleanup(holder.cleanup)
        base = Path(holder.name)
        subprocess.run([GIT, "init", "-q", str(base)], check=True)
        (base / "node_modules").mkdir()
        stub = base / "bin"
        stub.mkdir()
        for name, code in {"npm": npm_exit, **(stubs or {})}.items():
            program = stub / name
            program.write_text(f"#!/usr/bin/env bash\nexit {code}\n", encoding="utf-8", newline="\n")
            program.chmod(0o755)
        env = {**os.environ, "PATH": f"{stub}{os.pathsep}{os.environ['PATH']}",
               "HARNESS_TIMINGS": str(timings)}
        return base, env

    def run_mode(self, mode, npm_exit, timings, stubs=None):
        base, env = self.scratch(npm_exit, timings, stubs)
        return subprocess.run([BASH, str(SCRIPTS / "npm-checks.sh"), mode],
                              capture_output=True, text=True, cwd=str(base), env=env)

    def test_a_passing_run_records_its_script_mode_and_exit(self):
        holder = tempfile.TemporaryDirectory(prefix="npm-timings-")
        self.addCleanup(holder.cleanup)
        timings = Path(holder.name) / "timings.jsonl"
        out = self.run_mode("fast", 0, timings)
        self.assertEqual(0, out.returncode, out.stderr)
        lines = [json.loads(line) for line in timings.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(1, len(lines))
        self.assertEqual(("npm-checks.sh", "fast", 0),
                         (lines[0]["script"], lines[0]["mode"], lines[0]["exit"]))

    def test_a_failing_run_keeps_its_exit_and_records_it(self):
        holder = tempfile.TemporaryDirectory(prefix="npm-timings-")
        self.addCleanup(holder.cleanup)
        timings = Path(holder.name) / "timings.jsonl"
        out = self.run_mode("lint", 7, timings)
        self.assertEqual(7, out.returncode, out.stderr)
        line = json.loads(timings.read_text(encoding="utf-8").splitlines()[0])
        self.assertEqual(7, line["exit"])

    def test_a_failed_record_changes_no_exit(self):
        holder = tempfile.TemporaryDirectory(prefix="npm-timings-")
        self.addCleanup(holder.cleanup)
        blocker = Path(holder.name) / "file"
        blocker.write_text("x", encoding="utf-8")
        # A path beneath a regular file cannot be created, so the record fails.
        unwritable = blocker / "timings.jsonl"
        for npm_exit in (0, 7):
            with self.subTest(npm_exit=npm_exit):
                out = self.run_mode("test", npm_exit, unwritable)
                self.assertEqual(npm_exit, out.returncode, out.stderr)
                # The premise: the record did fail, and said so.
                self.assertIn("was not recorded", out.stderr)

    def test_a_recorder_that_cannot_run_changes_no_exit(self):
        # Every interpreter the script may pick exits 1, so the exit is npm's
        # only while `|| true` swallows the recorder's: delete it and this fails.
        holder = tempfile.TemporaryDirectory(prefix="npm-timings-")
        self.addCleanup(holder.cleanup)
        timings = Path(holder.name) / "timings.jsonl"
        for npm_exit in (0, 7):
            with self.subTest(npm_exit=npm_exit):
                out = self.run_mode("test", npm_exit, timings,
                                    stubs={"py": 1, "python3": 1, "python": 1})
                self.assertEqual(npm_exit, out.returncode, out.stderr)

    def test_a_relative_call_from_a_subdirectory_still_records(self):
        # The recorder is found beside the script, not beside the path the
        # caller typed, which the script's own cd to the root would invalidate.
        holder = tempfile.TemporaryDirectory(prefix="npm-timings-")
        self.addCleanup(holder.cleanup)
        timings = Path(holder.name) / "timings.jsonl"
        base, env = self.scratch(0, timings)
        copy = base / ".claude" / "scripts"
        copy.mkdir(parents=True)
        for name in ("npm-checks.sh", "harness_timings.py"):
            shutil.copy(SCRIPTS / name, copy / name)
        sub = base / "sub"
        sub.mkdir()
        out = subprocess.run([BASH, "../.claude/scripts/npm-checks.sh", "lint"],
                             capture_output=True, text=True, cwd=str(sub), env=env)
        self.assertEqual(0, out.returncode, out.stderr)
        self.assertTrue(timings.exists(), out.stderr)

    def test_a_usage_error_records_nothing(self):
        holder = tempfile.TemporaryDirectory(prefix="npm-timings-")
        self.addCleanup(holder.cleanup)
        timings = Path(holder.name) / "timings.jsonl"
        out = self.run_mode("e2e", 0, timings)
        self.assertEqual(2, out.returncode, out.stderr)
        self.assertFalse(timings.exists())


if __name__ == "__main__":
    unittest.main()
