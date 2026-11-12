"""This repository's own commands, as the payload's grant and runbook cases read them.

The payload's `test_command_grants.py` and `test_command_runbooks.py` own the cases and read this module
through `review_helpers.py`'s `LOCAL`; `docs/harness-local.md` *Ship checks* names the chain.
"""

# Its split commands' runbook ceilings, in bytes with CRLF counted as LF: each landed size and about a tenth.
CEILINGS = {
    "review-branch.md": 11700,
}

# Its own suites that list a tree rather than name its files, for the payload's `suite_select.py` to add after
# its own rows once a sync brings it: every tracked path for the class map and the deny coverage, the commands
# for the check runner's grants.
TREE_READERS = (
    ("**", ("test_class_map_frontend.EveryTrackedPathHasAClass", "test_review_branch_frontend")),
    (".claude/commands/*.md", ("test_npm_checks.TheCheckRunnerIsTheOnlyExecutor",)),
)
