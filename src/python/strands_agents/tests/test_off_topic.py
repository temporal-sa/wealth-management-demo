"""Off-topic questions are declined through the supervisor's prompt, not guardrail code.

The specialists are called as tools, so every customer message reaches the
supervisor first; both supervisors (Temporal and standalone) carry the decline
block right after their first line.
"""

import pathlib
import re

from prompts.agent_constants import (
    BENE_INSTRUCTIONS,
    INVEST_INSTRUCTIONS,
    OPEN_ACCOUNT_INSTRUCTIONS,
    SUPERVISOR_INSTRUCTIONS,
    TEMPORAL_INVEST_SUBAGENT_INSTRUCTIONS,
    TEMPORAL_SUPERVISOR_INSTRUCTIONS,
)

DECLINE_BLOCK = """You only help with wealth management: the customer's beneficiaries and investment accounts.
If the customer asks about anything else (for example general knowledge, weather, news, or
other financial products), politely decline, say that you can only help with beneficiaries
and investment accounts, and do not answer the question. Then ask how you can help with
their beneficiaries or investment accounts."""

PORT = pathlib.Path(__file__).resolve().parents[1]
# The port's code, plus the shared Python code it uses (src/python/common).
CODE_DIRS = [PORT / "standalone", PORT / "durable", PORT / "prompts", PORT.parent / "common"]


def test_supervisors_decline_off_topic_questions():
    for instructions in (SUPERVISOR_INSTRUCTIONS, TEMPORAL_SUPERVISOR_INSTRUCTIONS):
        first_line, rest = instructions.split("\n", 1)
        assert first_line == "You are a helpful wealth management assistant."
        assert rest.startswith(DECLINE_BLOCK)


def test_specialists_hand_off_topic_requests_back():
    for instructions in (
        BENE_INSTRUCTIONS,
        INVEST_INSTRUCTIONS,
        TEMPORAL_INVEST_SUBAGENT_INSTRUCTIONS,
        OPEN_ACCOUNT_INSTRUCTIONS,
    ):
        assert "If the request is not related to this routine, do not answer it." in instructions


def test_no_guardrail_code_remains():
    pattern = re.compile(r"guardrail|tripwire|ROUTING_INSTRUCTIONS|disable_guardrails", re.IGNORECASE)
    files = [path for code_dir in CODE_DIRS for path in code_dir.rglob("*.py")]
    assert len(files) > 20  # the scan really covers the code
    offenders = [str(path.relative_to(PORT.parent)) for path in files if pattern.search(path.read_text())]
    assert offenders == []
