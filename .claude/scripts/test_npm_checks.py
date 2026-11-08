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
        seen = 0
        for path in sorted(COMMANDS.glob("*.md")):
            seen += 1
            text = path.read_text(encoding="utf-8")
            for line in re.findall(r"^allowed-tools:\s*(.+)$", text, re.MULTILINE):
                for forbidden in ("Bash(npm ", "Bash(npx ", "Bash(node ",
                                  "Bash(ng ", "Bash(yarn ", "Bash(pnpm "):
                    with self.subTest(command=path.name, grant=forbidden):
                        self.assertNotIn(forbidden, line)
        # The positive control: an empty glob would satisfy every case above.
        self.assertGreater(seen, 3, "found almost no commands")

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
