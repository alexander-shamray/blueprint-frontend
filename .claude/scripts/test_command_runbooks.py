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

    def test_every_runbook_cites_and_every_citation_parses(self):
        # **Per runbook, because the global count above is satisfied by one
        # file's citations** (review of the PR that added this case): a runbook
        # could lose every `(why: …)` or write one the pattern does not match,
        # and stay green. Each opening is a claim that a section argues the
        # rule, so the number of openings must equal the number that parse.
        for name in CEILINGS:
            with self.subTest(command=name):
                text = collapsed(COMMANDS / name)
                openings = text.count("(why:")
                parsed = len(CITATION.findall(text))
                self.assertGreater(openings, 0, f"{name} cites nothing")
                self.assertEqual(
                    openings, parsed,
                    f"{name} has {openings} '(why:' openings but {parsed} "
                    "parse as citations")

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


class TheBoundariesIndexMatchesItsHeadings(unittest.TestCase):
    """blueprint-frontend#304 — `docs/harness-boundaries.md` opens with an index
    that names each `## ` section in an italic table row, and nothing held the
    two together. A heading added, renamed or removed left the index pointing
    at a section that was not there, or silent about one that was.

    The sizes in the second column are approximate and are not asserted.
    """

    DOC = SCRIPTS.parent.parent / "docs" / "harness-boundaries.md"
    ROW = re.compile(r"^\| \*(?P<name>.+)\* \|")

    def parts(self):
        lines = self.DOC.read_text(encoding="utf-8").splitlines()
        headings = [line[3:] for line in lines if line.startswith("## ")]
        first = next((i for i, line in enumerate(lines)
                      if line.startswith("## ")), len(lines))
        rows = []
        for line in lines[:first]:
            match = self.ROW.match(line)
            if match:
                rows.append(match["name"])
        return headings, rows

    def test_the_file_has_headings_and_an_index_to_hold_them_to(self):
        headings, rows = self.parts()
        self.assertTrue(headings, "no `## ` heading was found to judge")
        self.assertTrue(rows, "no italic index row was found before the first heading")

    def test_every_heading_is_an_index_row_in_order_and_every_row_a_heading(self):
        headings, rows = self.parts()
        self.assertEqual(
            headings, rows,
            "the index above the first `## ` heading and the headings differ")


if __name__ == "__main__":
    unittest.main()
