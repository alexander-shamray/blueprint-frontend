#!/usr/bin/env python3
"""alexander-shamray/blueprint-frontend#195: the code-index MCP server keeps the
root it started in, which `EnterWorktree` does not change.

`index-mcp-root.py` refuses a call made from another checkout than the one the
server reads, and names the `run-index` line that reads this one.
"""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
CLAUDE = SCRIPTS.parent
HOOK = CLAUDE / "hooks" / "index-mcp-root.py"
SETTINGS = CLAUDE / "settings.json"
SKILL = CLAUDE / "skills" / "codebase-index" / "SKILL.md"
MCP = "mcp__codebase-index__"


def load():
    spec = importlib.util.spec_from_file_location("index_mcp_root", HOOK)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Checkouts(unittest.TestCase):
    def setUp(self):
        self._scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self._scratch.cleanup)
        self.scratch = Path(self._scratch.name)
        self.main = self.scratch / "main"
        (self.main / ".git").mkdir(parents=True)
        self.tree = self.main / ".claude" / "worktrees" / "wt"
        (self.tree / "src").mkdir(parents=True)
        (self.tree / ".git").write_text("gitdir: ../../../.git/worktrees/wt\n", encoding="utf-8")

    def run_hook(self, payload, project=None):
        env = {**os.environ}
        env.pop("CLAUDE_PROJECT_DIR", None)
        if project is not None:
            env["CLAUDE_PROJECT_DIR"] = str(project)
        data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        return subprocess.run([sys.executable, str(HOOK)], input=data, env=env,
                              capture_output=True, timeout=30)

    def denied(self, tool, given, cwd, project=None):
        done = self.run_hook({"tool_name": MCP + tool, "tool_input": given, "cwd": str(cwd)},
                             self.main if project is None else project)
        self.assertEqual(0, done.returncode, done.stderr)
        if not done.stdout.strip():
            return None
        out = json.loads(done.stdout)["hookSpecificOutput"]
        self.assertEqual("deny", out["permissionDecision"])
        return out["permissionDecisionReason"]


class TheCallIsJudgedByTheCheckoutItIsMadeFrom(Checkouts):
    def test_a_call_from_a_worktree_is_refused_with_the_line_that_reads_it(self):
        text = self.denied("find_refs", {"symbol": "CartStore"}, self.tree / "src")

        self.assertIn("bash .claude/skills/codebase-index/scripts/run-index refs CartStore --json", text)
        self.assertIn("alone on its line", text)
        self.assertIn(str(self.main.absolute()), text)

    def test_a_call_from_the_checkout_the_server_reads_goes_through(self):
        self.assertIsNone(self.denied("find_refs", {"symbol": "CartStore"}, self.main / "src"))

    def test_a_session_launched_in_the_worktree_goes_through(self):
        self.assertIsNone(self.denied("find_refs", {"symbol": "CartStore"}, self.tree, project=self.tree))

    def test_healthcheck_is_never_refused(self):
        # Its `root` is how a session sees the mismatch.
        self.assertIsNone(self.denied("healthcheck", {}, self.tree))

    def test_a_tool_of_another_server_goes_through(self):
        done = self.run_hook({"tool_name": "mcp__other__find_refs", "tool_input": {}, "cwd": str(self.tree)},
                             self.main)
        self.assertEqual(b"", done.stdout.strip())

    def test_a_call_it_cannot_judge_goes_through(self):
        for payload in (b"", b"<html>", b"[1]", b"\xff\xfe",
                        {"tool_name": MCP + "find_refs", "tool_input": {"symbol": "X"}},
                        {"tool_name": MCP + "find_refs", "tool_input": {"symbol": "X"}, "cwd": ""}):
            with self.subTest(payload=payload):
                done = self.run_hook(payload, self.main)
                self.assertEqual(0, done.returncode, done.stderr)
                self.assertEqual(b"", done.stdout.strip())
        done = self.run_hook({"tool_name": MCP + "find_refs", "tool_input": {"symbol": "X"},
                              "cwd": str(self.tree)})
        self.assertEqual(b"", done.stdout.strip(), "no CLAUDE_PROJECT_DIR is a call it cannot judge")


class TheLineItNamesAnswersWhatWasAsked(unittest.TestCase):
    def setUp(self):
        self.hook = load()

    def test_each_tool_names_its_subcommand_and_arguments_in_order(self):
        cases = (
            ("search_code", {"query": "cart total", "limit": 3, "session": "s1"},
             "search 'cart total' --limit 3 --session s1 --json"),
            ("find_symbol", {"name": "CartStore"}, "symbol CartStore --json"),
            ("find_refs", {"symbol": "CartStore", "kind": "callers"}, "refs CartStore --kind callers --json"),
            ("path_between", {"source": "A", "target": "B"}, "path A B --json"),
            ("impact_of_diff", {}, "diff-impact --json"),
        )
        for tool, given, tail in cases:
            with self.subTest(tool=tool):
                self.assertEqual(f"`{self.hook.RUN} {tail}`", self.hook.command(tool, given))

    def test_a_call_carrying_what_the_line_cannot_carry_gets_the_bare_form(self):
        # A line dropping an argument would answer another question.
        for tool, given in (("find_refs", {"symbol": "A`b"}),
                            ("find_refs", {"symbol": "A", "kind": "everything"}),
                            ("find_refs", {"symbol": "A", "surprise": 1}),
                            ("search_code", {"query": "x", "limit": -1}),
                            ("search_code", {"query": ""})):
            with self.subTest(given=given):
                self.assertIn("with the call's arguments and `--json`", self.hook.command(tool, given))

    def test_every_tool_it_maps_is_a_subcommand_the_skill_approves(self):
        front = SKILL.read_text(encoding="utf-8").split("---")[1]
        for tool, (sub, _positional, _tagged) in self.hook.COMMANDS.items():
            with self.subTest(tool=tool):
                self.assertIn(f"Bash({self.hook.RUN} {sub}:*)", front)


class TheHookIsWired(unittest.TestCase):
    def test_it_is_registered_for_the_index_tools_through_the_launcher_and_fails_open(self):
        entries = json.loads(SETTINGS.read_text(encoding="utf-8"))["hooks"]["PreToolUse"]
        found = [(entry["matcher"], hook["command"]) for entry in entries for hook in entry["hooks"]
                 if "index-mcp-root.py" in hook["command"]]

        self.assertEqual(1, len(found), found)
        matcher, command = found[0]
        self.assertRegex("mcp__codebase-index__find_refs", matcher)
        self.assertNotRegex("mcp__other__find_refs", matcher)
        self.assertIn("run-guard.sh", command)
        # A launcher exit of 2 would block every index call of the session.
        self.assertTrue(command.endswith("|| :"), command)


if __name__ == "__main__":
    unittest.main()
