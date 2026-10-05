"""What `.claude/hooks/index-query-hint.py` says, and to which prompts.

It fails open and is silent on most, so its exit status proves nothing; the
cases run it as a process over stdin and read what it printed. The wiring
cases run the command `settings.json` registers, through the launcher, because
the one failure that matters here — exit 2, which erases the prompt — is the
launcher's to produce. Ported from blueprint-backend's suite (#513).
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
CLAUDE = SCRIPTS.parent
HINT = CLAUDE / "hooks" / "index-query-hint.py"
LAUNCHER = CLAUDE / "hooks" / "run-guard.sh"
SETTINGS = CLAUDE / "settings.json"
SKILL = CLAUDE / "skills" / "codebase-index" / "SKILL.md"
EVENT = "UserPromptSubmit"
COMMAND = 'sh "${CLAUDE_PROJECT_DIR}/.claude/hooks/run-guard.sh" index-query-hint.py || :'

# One prompt per alternative of each pattern, and the subcommand it routes to.
CASES = {
    "what breaks if CartStore changes?": "impact",
    "What depends on MoneyPipe?": "impact",
    "what is the impact of renaming the quote reply": "impact",
    "who calls placeOrder": "refs",
    "what calls the auth interceptor?": "refs",
    "What uses ClientConfig in checkout?": "refs",
    "how does the cart work?": "explain",
    "How does auth.strategy work": "explain",
    "how does the token refresh keep working": "explain",
    "how does the quote poll works": "explain",
    "find the class that formats money": "symbol",
    "find method names for cancel": "symbol",
    "find handlers for the 401 replay": "symbol",
    "find the classes under core/api": "symbol",
    "find the component that renders the cart": "symbol",
    "find services that call the BFF": "symbol",
    "where is the checkout form?": "search",
    "Where are the wire types kept": "search",
    "where does the cart persist its lines": "search",
}

# Each looks like a question above and is not one.
NOT_QUESTIONS = (
    "somewhere is a bug in checkout",
    "elsewhere is fine",
    "the impact offset is wrong",
    "nobody calls back",
    "how does it. Work on the cart next",
    "finder classes need a rename",
    "rewhere is not a word",
    "fix the build",
    "",
)


def run(payload):
    """The hook as a process whose text stdin is what a Windows pipe gets, so
    a case about decoding means the same on every host."""
    return subprocess.run(
        [sys.executable, str(HINT)], input=payload, capture_output=True,
        timeout=30, check=False,
        env=dict(os.environ, PYTHONIOENCODING="cp1252:surrogateescape"))


def ask(prompt):
    return run(json.dumps({"hook_event_name": EVENT, "prompt": prompt}).encode())


def context(done):
    """The `additionalContext` a run returned, or '' when it said nothing."""
    if not done.stdout.strip():
        return ""
    answer = json.loads(done.stdout)
    output = answer["hookSpecificOutput"]
    assert output["hookEventName"] == EVENT, answer
    return output["additionalContext"]


def emitted(text):
    """The command inside the hint's backticks."""
    found = re.search(r"`([^`]+)`", text)
    assert found, text
    return found.group(1)


def _module():
    import importlib.util

    spec = importlib.util.spec_from_file_location("index_query_hint", HINT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TheWiring(unittest.TestCase):

    def test_it_runs_on_every_prompt_and_under_no_other_event(self):
        hooks = json.loads(SETTINGS.read_text(encoding="utf-8"))["hooks"]
        running = [
            event for event, entries in hooks.items()
            for entry in entries
            for hook in entry.get("hooks", [])
            if hook.get("command") == COMMAND
        ]
        self.assertEqual([EVENT], running)

    def test_its_entry_has_no_matcher(self):
        # A prompt event takes none; one written would be ignored or read as
        # a filter nobody meant.
        hooks = json.loads(SETTINGS.read_text(encoding="utf-8"))["hooks"]
        for entry in hooks[EVENT]:
            self.assertNotIn("matcher", entry)

    def test_the_launcher_admits_it(self):
        launcher = LAUNCHER.read_text(encoding="utf-8")
        self.assertRegex(launcher, r"\|index-query-hint\.py\)")

    def test_the_registered_command_cannot_erase_a_prompt(self):
        # The launcher exits 2 whenever it cannot prove it ran the hook — no
        # Python, a remembered interpreter gone, a hook file missing — and
        # exit 2 under this event erases the prompt. The command's `|| :` is
        # what turns each of those into silence. Run as the harness runs it,
        # in a project path holding a space, in one whose launcher has no hook
        # to run, and in one with no launcher at all. Not an apostrophe: on
        # Windows the launcher cannot run any hook from such a path, which is
        # blueprint-frontend#143 and not this case's subject.
        sh = shutil.which("sh")
        if sh is None:
            self.fail("sh is required: the registered command starts with it")
        event = json.dumps({"hook_event_name": EVENT, "prompt": "where is X"}).encode()
        scratch = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, scratch, ignore_errors=True)
        quoted = Path(scratch, "two words")
        hollow = Path(scratch, "hollow")
        for root, names in ((quoted, ("run-guard.sh", "run-guard.py", HINT.name)),
                            (hollow, ("run-guard.sh", "run-guard.py"))):
            (root / ".claude" / "hooks").mkdir(parents=True)
            for name in names:
                shutil.copyfile(LAUNCHER.parent / name, root / ".claude" / "hooks" / name)
        for root, hinted in ((quoted, True), (hollow, False), (Path(scratch), False)):
            for attempt in ("probed", "remembered"):
                with self.subTest(root=root.name, attempt=attempt):
                    done = subprocess.run(
                        [sh, "-c", COMMAND], input=event, capture_output=True,
                        timeout=60, check=False,
                        env=dict(os.environ, CLAUDE_PROJECT_DIR=str(root)))
                    self.assertEqual(0, done.returncode, done.stderr)
                    self.assertEqual(hinted, bool(context(done)), done.stderr)


class TheHint(unittest.TestCase):

    def test_each_kind_of_question_names_its_own_subcommand(self):
        for prompt, subcommand in CASES.items():
            with self.subTest(prompt=prompt):
                done = ask(prompt)
                self.assertEqual(0, done.returncode, done.stderr)
                command = emitted(context(done))
                self.assertEqual(subcommand, command.split()[2], command)

    def test_every_route_is_reached_by_a_case(self):
        reached = {emitted(context(ask(prompt))) for prompt in CASES}
        self.assertEqual({row[2] for row in _module().ROUTES}, reached)

    def test_a_phrase_that_is_not_the_question_is_silent(self):
        for prompt in NOT_QUESTIONS:
            with self.subTest(prompt=prompt):
                done = ask(prompt)
                self.assertEqual(0, done.returncode, done.stderr)
                self.assertEqual(b"", done.stdout.strip())

    def test_ship_and_branch_are_read_for_the_task_they_carry(self):
        for prompt in ("/ship where is the auth interceptor?",
                       "/branch how does checkout work"):
            with self.subTest(prompt=prompt):
                self.assertTrue(context(ask(prompt)))

    def test_every_other_slash_command_is_silent_whatever_follows_it(self):
        for prompt in ("/commit where is the auth interceptor?",
                       "/shipping where is it", "/review-branch who calls X",
                       "  /pr how does it work"):
            with self.subTest(prompt=prompt):
                self.assertEqual(b"", ask(prompt).stdout.strip())

    def test_only_the_prompt_is_read_and_never_the_rest_of_the_payload(self):
        payload = {"hook_event_name": EVENT, "prompt": "fix the build",
                   "cwd": "C:/where is/who calls", "transcript_path": "where are"}
        self.assertEqual(b"", run(json.dumps(payload).encode()).stdout.strip())

    def test_a_prompt_spread_over_lines_still_reads(self):
        self.assertTrue(context(ask("where\nis the cart store")))

    def test_a_long_prompt_is_read_as_far_as_the_cap(self):
        cap = _module().CAP
        self.assertTrue(context(ask("where is it " + "x" * (cap * 4))))
        self.assertEqual(b"", ask("x " * cap + "where is it").stdout.strip())

    def test_a_prompt_holding_non_ascii_text_is_routed(self):
        payload = json.dumps({"hook_event_name": EVENT,
                              "prompt": "where is the \u0141\u00f3d\u017a cart \u2014 the store?"},
                             ensure_ascii=False).encode("utf-8")
        self.assertTrue(context(run(payload)))

    def test_the_prompt_is_decoded_as_utf_8(self):
        # `\u00e9where` asks nothing, `\u00e9` being a word character; read in
        # the ANSI code page Python gives a Windows pipe it becomes
        # `\u00c3\u00a9`, whose `\u00a9` is not, and the hint fires on a
        # prompt with no question.
        payload = json.dumps({"hook_event_name": EVENT, "prompt": "\u00e9where is the cart"},
                             ensure_ascii=False).encode("utf-8")
        self.assertEqual(b"", run(payload).stdout.strip())

    def test_input_it_cannot_read_is_silent_and_never_blocks(self):
        for payload in (b"", b"<html>", b"\xff\xfe\x00", b'{"prompt": 7}',
                        b"[1, 2]", b'{"prompt": null}'):
            with self.subTest(payload=payload):
                done = run(payload)
                self.assertEqual(0, done.returncode, done.stderr)
                self.assertEqual(b"", done.stdout.strip())


class TheSkillAgrees(unittest.TestCase):
    """A hint naming a command the skill does not route, or does not approve,
    sends the session to a permission prompt instead of the index."""

    def setUp(self):
        self.skill = SKILL.read_text(encoding="utf-8")

    def test_every_command_it_emits_is_a_row_of_the_route_table(self):
        rows = set(re.findall(r"^\|[^|]+\| `([^`]+)` \|$", self.skill, re.M))
        self.assertTrue(rows, "the route table was not found")
        for _kind, _pattern, command in _module().ROUTES:
            with self.subTest(command=command):
                self.assertIn(command, rows)

    def test_search_carries_the_limit_the_skill_sets(self):
        self.assertIn("**`search` takes `--limit 3`**", self.skill)
        search = [row[2] for row in _module().ROUTES if " search " in row[2]]
        self.assertEqual(1, len(search))
        self.assertIn("--limit 3", search[0])

    def test_every_subcommand_it_names_is_one_the_skill_approves(self):
        front = self.skill.split("---")[1]
        for _kind, _pattern, command in _module().ROUTES:
            prefix = " ".join(command.split()[:3])
            with self.subTest(command=command):
                self.assertIn(f"Bash({prefix}:*)", front)


if __name__ == "__main__":
    unittest.main()
