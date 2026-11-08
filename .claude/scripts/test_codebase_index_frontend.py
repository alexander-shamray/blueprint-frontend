"""How this repository starts the code-index server, and the CLI's pin.

`docs/harness-local.md` *Residuals* says why these cases are local.
Run: py -3.12 -m unittest discover -s .claude/scripts -p 'test_codebase_index_frontend.py'
"""

import json
import os
import re
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
ROOT = SCRIPTS.parent.parent


class TheMcpServerStartsWithoutAShell(unittest.TestCase):
    def test_the_mcp_server_starts_without_a_shell(self):
        # Claude Code starts a stdio server with the Windows PATH, not inside
        # Git Bash, and the first `bash` there is WSL's launcher, which exits at
        # once on a host with no distribution. The server starts through a Node
        # launcher, which judges the index first (`test_mcp_launch.py` runs it),
        # and the auto-update disable is in the server's own environment.
        servers = json.loads((ROOT / ".mcp.json").read_text(encoding="utf-8"))["mcpServers"]
        self.assertTrue(servers)
        for name, server in servers.items():
            with self.subTest(server=name):
                command = os.path.basename(server.get("command", "")).lower()
                self.assertNotIn(command, {"bash", "bash.exe", "sh", "sh.exe"})
        server = servers["codebase-index"]
        self.assertEqual("node", server["command"])
        self.assertEqual([".claude/skills/codebase-index/scripts/mcp-launch.mjs"], server["args"])
        self.assertEqual({"CBX_NO_SKILL_AUTO_UPDATE": "1"}, server["env"])


class TheCodeIndexCliIsInstalledAtAPinnedVersion(unittest.TestCase):
    """The hooks and the MCP server run this CLI unprompted, so it stays pinned.
    `docs/testing.md` owns the version and `CLAUDE.md` cites it, so the cases
    ask both halves of that.
    """

    DOCS = ROOT / "docs" / "testing.md"
    CLAUDE = ROOT / "CLAUDE.md"
    REQUIREMENTS = ROOT / "docs" / "codebase-index-requirements.txt"
    INSTALL = re.compile(r"pip install[^\n]*?codebase-index(?P<spec>[^\s\"'`]*)")

    def test_the_owner_names_an_exact_version_and_a_wheel_hash(self):
        text = self.DOCS.read_text(encoding="utf-8")
        self.assertRegex(text, r"codebase-index==\d+\.\d+\.\d+")
        self.assertRegex(text, r"sha256:[0-9a-f]{64}")

    def test_no_install_instruction_leaves_the_package_unpinned(self):
        found = 0
        for path in (self.DOCS, self.CLAUDE):
            for match in self.INSTALL.finditer(path.read_text(encoding="utf-8")):
                found += 1
                with self.subTest(path=path.name, spec=match["spec"]):
                    self.assertRegex(match["spec"], r"^==\d+\.\d+\.\d+")
        self.assertGreater(found, 0, "no install instruction was found to judge")

    def test_claude_md_cites_the_owner_instead_of_restating_the_install(self):
        claude = self.CLAUDE.read_text(encoding="utf-8")
        self.assertIn("`docs/testing.md` pins", claude)
        self.assertIn("The code-index CLI is pinned", self.DOCS.read_text(encoding="utf-8"))

    def test_the_install_block_is_the_hashed_requirements_file(self):
        # A hashed install split over two lines gives the one-line case nothing
        # to find, so this holds the install itself.
        text = self.DOCS.read_text(encoding="utf-8")
        self.assertIn("pip install --require-hashes \\\n    -r "
                      "docs/codebase-index-requirements.txt", text)
        self.assertTrue(self.REQUIREMENTS.is_file(), "the requirements file is gone")
        body = self.REQUIREMENTS.read_text(encoding="utf-8")
        version = re.search(r"`codebase-index==(\d+\.\d+\.\d+)`", text)
        self.assertIsNotNone(version, "testing.md names no pinned version")
        self.assertRegex(body, rf"(?m)^codebase-index=={re.escape(version[1])} \\$")

    def test_every_requirement_in_the_file_carries_a_hash(self):
        body = self.REQUIREMENTS.read_text(encoding="utf-8")
        entries = re.findall(r"(?m)^([A-Za-z0-9_.-]+==\S+) \\\n((?:    --hash=\S+.*\n)+)", body)
        pinned = re.findall(r"(?m)^[A-Za-z0-9_.-]+==\S+", body)
        self.assertTrue(entries, "no hashed requirement was found")
        self.assertEqual(len(entries), len(pinned), "a requirement carries no --hash line")
        for name, hashes in entries:
            with self.subTest(requirement=name):
                for line in hashes.splitlines():
                    self.assertRegex(line, r"^    --hash=sha256:[0-9a-f]{64}( \\)?$")


if __name__ == "__main__":
    unittest.main()
