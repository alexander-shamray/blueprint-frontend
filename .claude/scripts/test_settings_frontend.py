"""The toolchain's edit denies, held in the rendered `.claude/settings.json`.

`.harness/config.json` adds them; `docs/harness-local.md` *Residuals* argues them.
Run: py -3.12 -m unittest discover -s .claude/scripts -p 'test_settings_frontend.py'
"""

import fnmatch
import json
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
SETTINGS = SCRIPTS.parent / "settings.json"
CONFIG = SCRIPTS.parent.parent / ".harness" / "config.json"


def deny():
    return json.loads(SETTINGS.read_text(encoding="utf-8"))["permissions"]["deny"]


class TheEditDeniesTheChecksRunOnAreInSettings(unittest.TestCase):
    ALSO_IN_SETTINGS = (
        ".github/**", "package.json", "**/package.json", ".npmrc", "**/.npmrc",
        "angular.json", "tsconfig.json", "tsconfig.app.json", "tsconfig.spec.json",
        "**/tsconfig*.json", "**/*.config.cjs", "**/*.config.mjs", "**/*.config.mts",
        "**/vitest.config.ts", "**/vite.config.ts", "**/playwright.config.ts",
        "**/capacitor.config.ts", "node_modules/**",
    )

    def test_each_is_denied_in_both_spellings(self):
        rules = deny()
        for path in self.ALSO_IN_SETTINGS:
            for prefix in ("", "./"):
                if prefix and path.startswith("**"):
                    continue
                with self.subTest(path=path, prefix=prefix):
                    self.assertIn(f"Edit({prefix}{path})", rules)

    def test_each_comes_from_this_repositorys_config(self):
        # The rendered file is the sync's output; the config is the input this
        # repository owns. A deny that held only because a sync happened to
        # write it would go with the next one.
        config = json.loads(CONFIG.read_text(encoding="utf-8"))["settings"]["deny"]
        for path in self.ALSO_IN_SETTINGS:
            with self.subTest(path=path):
                self.assertIn(f"Edit({path})", config)

    def test_the_linters_own_config_is_the_stated_exception(self):
        # `/style-pass` records a corrected form in `eslint.config.js` and
        # `.prettierrc`, and a settings deny beats a command's own allowance,
        # so these stay out of the list: `docs/harness-local.md` *Residuals*
        # states the residual as accepted.
        rules = deny()
        for path in ("eslint.config.js", "./eslint.config.js", ".prettierrc",
                     "./.prettierrc", "**/*.config.js"):
            with self.subTest(path=path):
                self.assertNotIn(f"Edit({path})", rules)

    def test_the_composition_root_is_not_denied(self):
        # `**/*.config.ts` matches src/app/app.config.ts, which ordinary changes
        # edit, so the build configs are named instead.
        for rule in deny():
            if not rule.startswith("Edit("):
                continue
            with self.subTest(rule=rule):
                self.assertFalse(fnmatch.fnmatchcase("src/app/app.config.ts", rule[len("Edit("):-1]))

    def test_the_rules_are_edit_and_never_write(self):
        # A `Write(path)` rule matches nothing and stops Claude Code starting.
        for rule in deny():
            with self.subTest(rule=rule):
                self.assertFalse(rule.startswith("Write("))


if __name__ == "__main__":
    unittest.main()
