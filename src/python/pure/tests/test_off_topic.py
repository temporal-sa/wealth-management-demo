"""Off-topic questions are declined by the Supervisor Agent's prompt, in both versions."""

import common.agent_constants as agent_constants
import pure_supervisor.main as standalone
from common.agent_constants import SUPERVISOR_AGENT_NAME
from common.agent_loop import all_agents
from temporal_supervisor.workflows.supervisor_workflow import init_agents

DECLINE_BLOCK = [
    "You only help with wealth management: the customer's beneficiaries and investment accounts.",
    "If the customer asks about anything else (for example general knowledge, weather, news, or",
    "other financial products), politely decline, say that you can only help with beneficiaries",
    "and investment accounts, and do not answer the question. Then ask how you can help with",
    "their beneficiaries or investment accounts.",
]


def _lines(text: str) -> list[str]:
    return [line.strip() for line in text.splitlines()]


def test_supervisor_instructions_contain_the_decline_block():
    lines = _lines(agent_constants.SUPERVISOR_INSTRUCTIONS)
    start = lines.index(DECLINE_BLOCK[0])
    assert lines[start:start + len(DECLINE_BLOCK)] == DECLINE_BLOCK
    assert start < lines.index("# Routine")


def test_both_versions_give_the_supervisor_the_decline_block():
    for supervisor in (init_agents(), standalone.supervisor_agent):
        assert supervisor.name == SUPERVISOR_AGENT_NAME
        assert supervisor.instructions == agent_constants.SUPERVISOR_INSTRUCTIONS
        # The supervisor only routes: it has no tools that could answer a question itself.
        assert supervisor.tools == []


def test_specialists_transfer_off_topic_questions_back():
    for instructions in (agent_constants.BENE_INSTRUCTIONS, agent_constants.INVEST_INSTRUCTIONS):
        assert "not related to the routine, transfer back to the supervisor agent" in instructions
    for instructions in (agent_constants.OPEN_ACCOUNT_INSTRUCTIONS,
                         agent_constants.STANDALONE_OPEN_ACCOUNT_INSTRUCTIONS):
        assert f"hand off to the {agent_constants.INVEST_AGENT_NAME}" in instructions


def test_every_agent_prompt_starts_with_the_handoff_prefix():
    for supervisor in (init_agents(), standalone.supervisor_agent):
        for agent in all_agents(supervisor).values():
            assert agent.instructions.startswith(agent_constants.HANDOFF_PROMPT_PREFIX), agent.name
