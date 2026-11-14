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


def rule_matches(rule, path):
    """Whether an `Edit(...)` rule covers `path`, given from the root. Read
    wide, since the tests ask what a rule must not cover: a leading `/` or
    `./` is the root, `**/` matches at the root too, a pattern with no slash
    matches a file's name at any depth, and `*` crosses directories."""
    pattern = rule[len("Edit("):-1]
    if pattern.startswith("./"):
        pattern = pattern[2:]
    elif pattern.startswith("/") and not pattern.startswith("//"):
        pattern = pattern[1:]
    patterns = [pattern] + ([pattern[3:]] if pattern.startswith("**/") else [])
    names = [path] + ([path.rsplit("/", 1)[-1]] if "/" not in pattern else [])
    return any(fnmatch.fnmatchcase(name, each) for name in names for each in patterns)


def edit_rules():
    return [rule for rule in deny() if rule.startswith("Edit(")]


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
        # states the residual as accepted. Every rule is matched against the
        # files, in whichever spelling it is written.
        for path in ("eslint.config.js", ".prettierrc"):
            for rule in edit_rules():
                with self.subTest(path=path, rule=rule):
                    self.assertFalse(rule_matches(rule, path))

    def test_the_composition_root_is_not_denied(self):
        # `**/*.config.ts` matches src/app/app.config.ts, which ordinary changes
        # edit, so the build configs are named instead.
        for path in ("src/app/app.config.ts", "src/app/app.routes.ts"):
            for rule in edit_rules():
                with self.subTest(path=path, rule=rule):
                    self.assertFalse(rule_matches(rule, path))

    def test_the_matcher_reads_every_spelling_of_a_rule(self):
        # The subject of the two cases above: a matcher that missed one of
        # these would pass them with that rule in the settings.
        for rule, path in (("Edit(/src/app/**)", "src/app/app.config.ts"),
                           ("Edit(./src/**)", "src/app/app.routes.ts"),
                           ("Edit(**/*.config.ts)", "src/app/app.config.ts"),
                           ("Edit(*.config.ts)", "src/app/app.config.ts"),
                           ("Edit(app.config.ts)", "src/app/app.config.ts"),
                           ("Edit(**/eslint.config.js)", "eslint.config.js"),
                           ("Edit(*.js)", "eslint.config.js"),
                           ("Edit(/.prettierrc)", ".prettierrc"),
                           ("Edit(./.prettierrc)", ".prettierrc"),
                           ("Edit(.prettier*)", ".prettierrc")):
            with self.subTest(rule=rule, path=path):
                self.assertTrue(rule_matches(rule, path))
        for rule, path in (("Edit(**/vite.config.ts)", "src/app/app.config.ts"),
                           ("Edit(**/*.config.mts)", "src/app/app.config.ts"),
                           ("Edit(**/*.config.cjs)", "eslint.config.js"),
                           ("Edit(.github/**)", ".prettierrc")):
            with self.subTest(rule=rule, path=path):
                self.assertFalse(rule_matches(rule, path))

    def test_the_rules_are_edit_and_never_write(self):
        # A `Write(path)` rule matches nothing and stops Claude Code starting.
        for rule in deny():
            with self.subTest(rule=rule):
                self.assertFalse(rule.startswith("Write("))


class TheFolderOpenTaskFileIsDenied(unittest.TestCase):
    def test_both_spellings_are_denied_from_this_repositorys_config(self):
        # `.vscode/tasks.json` can carry a task VS Code runs on folder open.
        config = json.loads(CONFIG.read_text(encoding="utf-8"))["settings"]["deny"]
        rules = deny()
        for rule in ("Edit(.vscode/**)", "Edit(./.vscode/**)"):
            with self.subTest(rule=rule):
                self.assertIn(rule, rules)
                self.assertIn(rule, config)


if __name__ == "__main__":
    unittest.main()
