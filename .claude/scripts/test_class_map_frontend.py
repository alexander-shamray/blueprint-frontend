"""The class map admits every tracked path, so no tree sits outside the contract.

`docs/change-locality.md` section 3 cites the map. Needs git on PATH.
Run: py -3.12 -m unittest discover -s .claude/scripts -p 'test_class_map_frontend.py'
"""

import re
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
CLASSES = ROOT / ".github" / "locality-gate" / "classes.yml"
GIT = shutil.which("git")


def class_map():
    classes, current = {}, None
    for line in CLASSES.read_text(encoding="utf-8").splitlines():
        head = re.fullmatch(r"([A-E]):", line)
        item = re.fullmatch(r"  - '([^']+)'", line)
        if head:
            current = classes.setdefault(head.group(1), [])
        elif item:
            current.append(item.group(1))
    return classes


def admits(token, path):
    # The same reading as `to_regex` in `pr-locality.sh`, which `test_pr_helpers.py` pins.
    pattern = re.sub(r"[.()+]", lambda m: "\\" + m.group(), token)
    pattern = pattern.replace("**", "%%GLOBSTAR%%").replace("*", "[^/]*").replace("?", "[^/]")
    pattern = pattern.replace("%%GLOBSTAR%%", ".*").replace("{", "(").replace("}", ")")
    return re.fullmatch(pattern.replace(",", "|") + "(/.*)?", path) is not None


class EveryTrackedPathHasAClass(unittest.TestCase):
    def test_the_map_holds_all_five_classes(self):
        self.assertEqual(set("ABCDE"), set(class_map()))

    def test_every_tracked_path_is_admitted_by_some_class(self):
        tokens = [token for items in class_map().values() for token in items]
        listed = subprocess.run([GIT, "ls-files", "-z"], cwd=ROOT, check=True,
                                capture_output=True, text=True, encoding="utf-8").stdout
        paths = [path for path in listed.split("\0") if path]
        self.assertTrue(paths)
        outside = [path for path in paths if not any(admits(t, path) for t in tokens)]
        self.assertEqual([], outside)

    def test_the_web_files_reach_the_classes_that_change_them(self):
        classes = class_map()
        self.assertTrue(any(admits(t, "public/silent-refresh.html") for t in classes["B"]))
        self.assertTrue(any(admits(t, "public/manifest.webmanifest") for t in classes["D"]))


if __name__ == "__main__":
    unittest.main()
