"""The long commands split into a runbook and its argument (#173).

A runbook is resident in every turn its command runs, and its argument is read
only when a rule is disputed or edited. These cases hold the two halves to each
other, and each runbook under a ceiling, so a runbook that regrows its argument
is a red build rather than a slow drift.

The subject is what the gate looks at: `CEILINGS` names the commands that are
split, and the first case fails when `docs/commands/` holds a file the list
does not, so a command split tomorrow cannot escape its ceiling in silence.
"""

import re
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
COMMANDS = SCRIPTS.parent / "commands"
ARGUMENTS = SCRIPTS.parent.parent / "docs" / "commands"

# Bytes with CRLF counted as LF, so a Windows checkout reads what Linux CI
# does; each landed size and about a tenth: a runbook past it has regrown.
CEILINGS = {
    "review-branch.md": 11700,
    "branch.md": 9900,
    "security-sweep.md": 14600,
    "bug-sweep.md": 20400,
    "ship.md": 36700,
}

# `docs/commands/<name>.md, *<heading>*`, after whitespace is collapsed: the
# form a runbook uses to cite the section that argues a rule.
CITATION = re.compile(r"docs/commands/([a-z-]+\.md)`?, \*([^*]+)\*")


def collapsed(path):
    return " ".join(path.read_text(encoding="utf-8").split())


class EachSplitCommandHasBothHalves(unittest.TestCase):

    def argued(self):
        names = sorted(p.name for p in ARGUMENTS.glob("*.md"))
        self.assertGreater(len(names), 0, "docs/commands/ holds no argument")
        return names

    def test_every_argument_has_a_ceiling_and_a_runbook_that_cites_it(self):
        for name in self.argued():
            with self.subTest(command=name):
                self.assertIn(name, CEILINGS, f"docs/commands/{name} has no ceiling")
                runbook = COMMANDS / name
                self.assertTrue(runbook.is_file(), f"no runbook for {name}")
                self.assertIn(f"docs/commands/{name}", collapsed(runbook))

    def test_every_ceiling_has_an_argument(self):
        for name in CEILINGS:
            with self.subTest(command=name):
                self.assertTrue((ARGUMENTS / name).is_file(),
                                f"docs/commands/{name} is missing")

    def test_every_citation_names_a_heading_that_exists(self):
        cited = 0
        for runbook in sorted(COMMANDS.glob("*.md")):
            for target, heading in CITATION.findall(collapsed(runbook)):
                cited += 1
                with self.subTest(runbook=runbook.name, target=target,
                                  heading=heading):
                    path = ARGUMENTS / target
                    self.assertTrue(path.is_file(),
                                    f"cites a missing docs/commands/{target}")
                    headings = re.findall(
                        r"^#{2,3} (.+?)\s*$",
                        path.read_text(encoding="utf-8"), re.MULTILINE)
                    self.assertIn(heading, headings)
        self.assertGreater(cited, 0,
                           "the citation pattern stopped matching the runbooks")

    def test_each_runbook_stays_under_its_ceiling(self):
        for name, ceiling in CEILINGS.items():
            with self.subTest(command=name):
                size = len((COMMANDS / name).read_bytes().replace(b"\r\n", b"\n"))
                self.assertLessEqual(size, ceiling,
                                     f"{name} is {size} bytes, over {ceiling}")

    def test_each_argument_names_its_runbook(self):
        for name in self.argued():
            with self.subTest(argument=name):
                self.assertIn(f".claude/commands/{name}",
                              collapsed(ARGUMENTS / name))


if __name__ == "__main__":
    unittest.main()
