"""Frontend's npm cases: the check runner and the grants it replaced.

Moved out of `test_harness_helpers.py`, which the first sync drops, by plan 5
Task 7 Step 5 (`blueprint-backend`'s
`docs/superpowers/plans/2026-11-06-shared-harness-5-frontend-sync.md`).
`npm-checks.sh` is this repository's stack, granted through
`.harness/config.json`, and `docs/harness-local.md` *Ship checks* names it.

Run: py -3.12 -m unittest discover -s .claude/scripts -p 'test_npm_checks.py'
Needs bash and git on PATH.
"""

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
# but only pinned to a script under `.claude/scripts/` or to the unittest
# runner `/ship`'s sync section runs the printed local suites with.
PINNED_PY = re.compile(
    r"py -3\.\d+ (?:\.claude/scripts/[\w.-]+\.py|-m unittest discover)(?::\*)?")


def program_word(grant):
    """The program a `Bash(...)` grant runs, however the grant spells it.

    `Bash(npx:*)`, `Bash(npx *)`, `Bash(npx)`, `Bash(NPX.exe:*)`,
    `Bash(npx.cmd:*)`, `Bash(/usr/bin/npx:*)`, `Bash(CI=1 npx:*)` and
    `Bash(env npx:*)` all run `npx`, and `Bash(python3.12:*)` runs
    `python`. The house form is the colon one, so a prefix ending in a space
    misses it. A colon before a slash is a drive letter, not the grant's
    wildcard. A wrapper with a flag or nothing after it is its own word,
    refused: a flag may take an argument, which would read as the program.
    """
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
        # `npm run:*` admits any script `package.json` names, including one the
        # granted command has just written; `npm test -- --config <path>`
        # admits a file Vitest executes in order to read it; `npx:*` fetches
        # and executes a package nobody pinned; and `node:*` is an interpreter
        # outright. The executor is `npm-checks.sh`, whose only variable is one
        # word out of a closed set. Asserted over every command, the payload's
        # included, since a sync can bring a grant this repository never wrote.
        # Judged by program word, never by a prefix ending in a space: the
        # house form is `Bash(<prefix>:*)`, which `"Bash(npx "` never matched.
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
                      "py -3.12 -m unittest discover:*", "git diff:*",
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


if __name__ == "__main__":
    unittest.main()
