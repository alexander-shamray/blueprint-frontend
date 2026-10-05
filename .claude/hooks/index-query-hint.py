#!/usr/bin/env python3
"""Point a locate, explain, references, impact or named-symbol prompt at the code index.

**Nothing ever asked a session to query the index
(alexander-shamray/blueprint-frontend#126).** The hooks refresh it; whether to
use it was left to the skill's `description`, and no session here ran the
skill after the day it was tuned. So on `UserPromptSubmit` a prompt that reads
as one of those questions gets one line of `additionalContext`: load the
skill, the route-table row for the question, and the session-tag rule. Every
other prompt gets nothing, and so does every slash command but `/ship` and
`/branch`, whose arguments are a task rather than an option.

**It reads the `prompt` string and nothing else in the event**, and runs no
index work and starts nothing. Each command it names is a row of `SKILL.md`'s
route table and a prefix its `allowed-tools` approves, which the suite holds,
so the hint never sends a session to a permission prompt instead of the index.

**It fails open, and its wiring does too.** Exit 2 under this event erases the
prompt, so this file answers 0 whatever happens, and the `settings.json`
command ends `|| :` so a launcher that could not run it cannot either.
Ported from blueprint-backend's `index-query-hint.py` (#513), which took the
patterns from blueprint-admin#94.
"""

import json
import re
import sys

# Enough for a question; a pasted log behind it is not one.
CAP = 4096

RUN = "bash .claude/skills/codebase-index/scripts/run-index"

# Checked in order, so a prompt carrying two questions is routed by the one
# that asks the most of the index. Each command is a row of SKILL.md's route
# table, spelled as the row spells it.
ROUTES = (
    ("change-impact", r"\b(?:what (?:breaks|depends)|impact of)\b",
     f'{RUN} impact "X" --json'),
    ("references", r"\b(?:who calls|what (?:calls|uses))\b",
     f'{RUN} refs "X" --json'),
    # A sentence end stops `how does … work`; a dot inside a name does not.
    ("how-it-works", r"\bhow does (?:[^.?!]|\.[^\s.?!])* work(?:s|ing)?\b",
     f'{RUN} explain "X" --session <tag> --json'),
    ("named-symbol", r"\bfind (?:the )?(?:class|method|handler|component|service)(?:es|s)?\b",
     f'{RUN} symbol "X" --json'),
    ("locate", r"\bwhere (?:is|are|does)\b",
     f'{RUN} search "X" --limit 3 --session <tag> --json'),
)

# The two commands whose arguments are a task rather than an option.
TASKS = re.compile(r"^/(?:ship|branch)(?=\s|$)")


def question(prompt):
    """The text matched: capped, lowered, spaced once, and a task's command
    stripped; any other slash command leaves nothing to match."""
    text = " ".join(prompt[:CAP].lower().split())
    if text.startswith("/"):
        if not TASKS.match(text):
            return ""
        text = TASKS.sub("", text, count=1)
    return text


def hint(prompt):
    text = question(prompt)
    for kind, pattern, command in ROUTES:
        if re.search(pattern, text):
            return (
                f"This reads as a {kind} question, so load the codebase-index "
                "skill and query the index before any Grep or Read of the tree, "
                f"starting with `{command}`. Pick one session tag for this "
                "conversation and pass it to every search and explain; start a "
                "new one after a clear or compaction, and never hand it to a "
                "subagent. Read only the recommended line ranges, and treat an "
                "empty refs or impact result as inconclusive.")
    return None


def main():
    # Bytes, decoded here: Python reads a Windows pipe in the ANSI code page,
    # which would garble a prompt holding anything outside it.
    try:
        raw = getattr(sys.stdin, "buffer", None)
        text = raw.read().decode("utf-8", "replace") if raw is not None else sys.stdin.read()
        event = json.loads(text or "{}")
        prompt = event.get("prompt") if isinstance(event, dict) else None
        found = hint(prompt) if isinstance(prompt, str) else None
        if found:
            print(json.dumps({"hookSpecificOutput": {
                "hookEventName": "UserPromptSubmit",
                "additionalContext": found}}))
    except Exception:  # noqa: BLE001 - a hint that fails says nothing
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
