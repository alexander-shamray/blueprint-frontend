#!/usr/bin/env python3
"""alexander-shamray/blueprint-frontend#138: the MCP server opens its index too.

`.mcp.json` starts the server through `mcp-launch.mjs`, which asks the hook's
`index_openable` (through `gate-index.py`) before it starts the CLI. These cases
run the real launcher under real Node, against a stand-in CLI.

The stand-in is a `codebase_index` package on `PYTHONPATH`, reached through the
launcher's `python -m codebase_index` fallback, because a stand-in for the
binary would have to be an `.exe` on Windows. The `PATH` the launcher sees holds
only Node and the interpreter launcher, so no real `codebase-index` shadows the
fallback.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
CLAUDE = SCRIPTS.parent
LAUNCHER = CLAUDE / "skills" / "codebase-index" / "scripts" / "mcp-launch.mjs"
MCP_JSON = CLAUDE.parent / ".mcp.json"
NODE = shutil.which("node")
FLOOR = "import sys; sys.exit(sys.version_info < (3, 12))"


def interpreter():
    """What the launcher would pick on this host, in its order: the first
    candidate that meets the 3.12 floor, as a path and the arguments it takes.

    `py` takes `-3.12`; the others are probed bare. A `python3` older than 3.12
    beside a `python` that meets it is a host the launcher serves, and a test
    that took only `python3` would fail there for a reason of its own.
    """
    for name, flags in (("py", ["-3.12"]), ("python3", []), ("python", [])):
        found = shutil.which(name)
        if found and subprocess.run([found, *flags, "-c", FLOOR],
                                    capture_output=True).returncode == 0:
            return found
    return None


PYTHON = interpreter()


def setUpModule():
    # Not a skip: a skip on a missing tool reports a pass.
    if NODE is None or PYTHON is None:
        raise RuntimeError("node and Python 3.12 are required on PATH: these cases run the launcher")


def expose(directory, tool):
    """Put `tool` in `directory` by copy on Windows and by link elsewhere."""
    target = Path(directory) / Path(tool).name
    if os.name == "nt":
        shutil.copyfile(tool, target)
    else:
        os.symlink(tool, target)


class TheMcpServerStartsOnlyOverAnIndexTheHookWouldOpen(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._base = tempfile.TemporaryDirectory()
        base = Path(cls._base.name)
        cls.node_only = base / "node-only"
        cls.with_python = base / "with-python"
        for directory in (cls.node_only, cls.with_python):
            directory.mkdir()
            expose(directory, NODE)
        expose(cls.with_python, PYTHON)
        cls.stubs = base / "stubs"
        package = cls.stubs / "codebase_index"
        package.mkdir(parents=True)
        (package / "__init__.py").write_text("", encoding="utf-8")
        (package / "__main__.py").write_text(
            "import os, sys\n"
            "print('stub-cli', *sys.argv[1:], os.environ.get('CBX_NO_SKILL_AUTO_UPDATE'))\n"
            "sys.exit(int(os.environ.get('STUB_EXIT', '0')))\n", encoding="utf-8")

    @classmethod
    def tearDownClass(cls):
        cls._base.cleanup()

    def setUp(self):
        self._root = tempfile.TemporaryDirectory()
        self.addCleanup(self._root.cleanup)
        self.root = Path(self._root.name)
        self.cache = self.root / ".claude" / "cache" / "codebase-index"

    def launch(self, path, **extra):
        env = {**os.environ, "PATH": str(path), "PYTHONPATH": str(self.stubs), **extra}
        env.pop("CBX_NO_SKILL_AUTO_UPDATE", None)
        return subprocess.run([NODE, str(LAUNCHER)], cwd=self.root, env=env, stdin=subprocess.DEVNULL,
                              capture_output=True, text=True, timeout=120)

    def test_a_clean_root_starts_the_server_with_its_arguments_and_the_update_disabled(self):
        done = self.launch(self.with_python)

        self.assertEqual(0, done.returncode, done.stderr)
        self.assertEqual("stub-cli mcp --root . 1", done.stdout.strip())

    def test_the_servers_exit_status_is_the_launchers(self):
        self.assertEqual(7, self.launch(self.with_python, STUB_EXIT="7").returncode)

    def test_a_rollback_journal_beside_the_index_stops_it_before_the_server_starts(self):
        self.cache.mkdir(parents=True)
        (self.cache / "index.sqlite-journal").write_bytes(b"branch-written")
        done = self.launch(self.with_python)

        self.assertEqual(3, done.returncode, done.stderr)
        self.assertIn("not starting the server", done.stderr)
        # stdout is the protocol: nothing of the launcher's, and no server.
        self.assertEqual("", done.stdout)

    def test_a_host_with_no_python_312_does_not_start_it_unjudged(self):
        done = self.launch(self.node_only)

        self.assertEqual(4, done.returncode, done.stderr)
        self.assertIn("no Python 3.12", done.stderr)
        self.assertEqual("", done.stdout)


class TheServerIsConfiguredToStartThroughIt(unittest.TestCase):
    def test_mcp_json_runs_the_launcher_with_node_and_no_shell(self):
        server = json.loads(MCP_JSON.read_text(encoding="utf-8"))["mcpServers"]["codebase-index"]

        self.assertEqual("node", server["command"])
        self.assertEqual([".claude/skills/codebase-index/scripts/mcp-launch.mjs"], server["args"])
        self.assertEqual({"CBX_NO_SKILL_AUTO_UPDATE": "1"}, server["env"])
        self.assertTrue((CLAUDE.parent / server["args"][0]).is_file())


if __name__ == "__main__":
    unittest.main()
