#!/usr/bin/env python3
"""alexander-shamray/blueprint-frontend#138: the skill's direct route to the index.

`run-index` and `cbx` ran the CLI over whatever index sat under the working
directory. They now ask `index_openable` first, through `gate-index.py`, and
the CLI is not started when it refuses.
"""

import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
SKILL_SCRIPTS = SCRIPTS.parent / "skills" / "codebase-index" / "scripts"
CACHE = Path(".claude") / "cache" / "codebase-index"


def python_312():
    probe = "import sys; sys.exit(sys.version_info < (3, 12))"
    for candidate in (["py", "-3.12"], ["python3"], ["python"]):
        if shutil.which(candidate[0]) and subprocess.run(
                [*candidate, "-c", probe], capture_output=True).returncode == 0:
            return True
    return False


# Resolved here and passed by path: `subprocess` looks a bare `bash` up in
# System32 first on Windows, which is WSL's launcher, not Git Bash.
BASH = shutil.which("bash")


@unittest.skipUnless(BASH and shutil.which("git") and python_312(),
                     "the gate needs bash, git and Python 3.12")
class TheCliIsNotStartedOverAnIndexTheHookRefuses(unittest.TestCase):
    def setUp(self):
        self._scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self._scratch.cleanup)
        self.scratch = Path(self._scratch.name)
        self.repo = self.scratch / "repo"
        self.repo.mkdir()
        subprocess.run(["git", "init", "-q"], cwd=self.repo, check=True, capture_output=True)
        self.cache = self.repo / CACHE
        # A stand-in for the CLI that says it ran; the gate is what is under test.
        self.bin = self.scratch / "bin"
        self.bin.mkdir()
        stub = self.bin / "codebase-index"
        stub.write_text("#!/bin/sh\necho cli-ran \"$@\"\n", encoding="utf-8", newline="\n")
        stub.chmod(0o755)

    def index(self, wal=True):
        self.cache.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self.cache / "index.sqlite", isolation_level=None)
        try:
            conn.execute(f"PRAGMA journal_mode={'WAL' if wal else 'DELETE'}")
            conn.execute("CREATE TABLE chunks (id INTEGER PRIMARY KEY, content TEXT)")
        finally:
            conn.close()

    def run_script(self, name, *args, cwd=None):
        env = {**os.environ, "PATH": f"{self.bin}{os.pathsep}{os.environ['PATH']}"}
        return subprocess.run([BASH, str(SKILL_SCRIPTS / name), *args], cwd=cwd or self.repo,
                              env=env, capture_output=True, text=True, timeout=60)

    def gate(self, cwd=None):
        return subprocess.run([sys.executable, "-I", str(SKILL_SCRIPTS / "gate-index.py")],
                              cwd=cwd or self.repo, capture_output=True, text=True, timeout=60)

    def test_a_root_with_no_index_is_admitted(self):
        self.assertEqual(0, self.gate().returncode)

    def test_a_wal_index_is_admitted(self):
        self.index()
        self.assertEqual(0, self.gate().returncode)

    def test_a_rollback_journal_beside_the_index_is_refused(self):
        self.index()
        (self.cache / "index.sqlite-journal").write_bytes(b"branch-written")
        done = self.gate()

        self.assertEqual(3, done.returncode, done.stderr)
        self.assertIn("refusing to open the index", done.stderr)

    def test_a_rollback_mode_header_is_refused(self):
        self.index(wal=False)
        self.assertEqual(3, self.gate().returncode)

    def test_a_subdirectory_is_judged_by_its_checkout(self):
        self.index()
        (self.cache / "index.sqlite-journal").write_bytes(b"x")
        sub = self.repo / "src"
        sub.mkdir()
        self.assertEqual(3, self.gate(cwd=sub).returncode)

    def test_a_directory_outside_a_checkout_is_left_to_the_cli(self):
        self.assertEqual(0, self.gate(cwd=self.scratch).returncode)

    def test_a_linked_cache_directory_is_refused(self):
        elsewhere = self.scratch / "elsewhere"
        elsewhere.mkdir()
        (self.repo / ".claude").mkdir()
        try:
            os.symlink(elsewhere, self.cache.parent / "codebase-index", target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("this host does not grant symlinks")
        self.assertEqual(3, self.gate().returncode)

    def test_both_wrappers_start_the_cli_on_a_clean_index_and_not_on_a_refused_one(self):
        self.index()
        for name, sub in (("run-index", "stats"), ("cbx", "stats")):
            with self.subTest(wrapper=name, index="clean"):
                done = self.run_script(name, sub)
                self.assertEqual(0, done.returncode, done.stderr)
                self.assertIn("cli-ran stats", done.stdout)
        (self.cache / "index.sqlite-journal").write_bytes(b"branch-written")
        for name, sub in (("run-index", "stats"), ("cbx", "stats")):
            with self.subTest(wrapper=name, index="journal"):
                done = self.run_script(name, sub)
                self.assertEqual(3, done.returncode, done.stderr)
                self.assertNotIn("cli-ran", done.stdout)


if __name__ == "__main__":
    unittest.main()
