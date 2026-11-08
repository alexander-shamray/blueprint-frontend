"""This repository's own commands, as the payload's grant and runbook cases read them.

The payload's `test_command_grants.py` and `test_command_runbooks.py` own the cases and read this module
through `review_helpers.py`'s `LOCAL`; `docs/harness-local.md` *Ship checks* names the chain.
"""

# Its split commands' runbook ceilings, in bytes with CRLF counted as LF: each landed size and about a tenth.
CEILINGS = {
    "review-branch.md": 11700,
}
