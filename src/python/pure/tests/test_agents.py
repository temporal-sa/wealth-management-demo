"""The four agents, their tools and their handoffs match the PRD, in both versions,
and the open-account prompt carries the PRD's lines word for word."""

import common.agent_constants as agent_constants
import pure_supervisor.main as standalone
from common.agent_constants import BENE_AGENT_NAME, INVEST_AGENT_NAME, OPEN_ACCOUNT_AGENT_NAME, SUPERVISOR_AGENT_NAME
from common.agent_loop import all_agents
from temporal_supervisor.workflows.supervisor_workflow import init_agents

HANDOFFS = {
    SUPERVISOR_AGENT_NAME: [BENE_AGENT_NAME, INVEST_AGENT_NAME],
    BENE_AGENT_NAME: [SUPERVISOR_AGENT_NAME],
    INVEST_AGENT_NAME: [OPEN_ACCOUNT_AGENT_NAME, SUPERVISOR_AGENT_NAME],
    OPEN_ACCOUNT_AGENT_NAME: [INVEST_AGENT_NAME],
}

TEMPORAL_TOOLS = {
    SUPERVISOR_AGENT_NAME: [],
    BENE_AGENT_NAME: ["list_beneficiaries", "add_beneficiary", "delete_beneficiary"],
    INVEST_AGENT_NAME: ["list_investments", "close_investment"],
    OPEN_ACCOUNT_AGENT_NAME: ["open_new_investment_account", "get_account_opening_status",
                              "get_current_client_info", "approve_kyc", "update_client_details"],
}

# The standalone version opens accounts directly: no status, KYC or client details tools.
STANDALONE_TOOLS = {**TEMPORAL_TOOLS, OPEN_ACCOUNT_AGENT_NAME: ["open_new_investment_account"]}


def _graph(supervisor):
    agents = all_agents(supervisor)
    return ({name: [h.name for h in a.handoffs] for name, a in agents.items()},
            {name: [t.name for t in a.tools] for name, a in agents.items()})


def test_temporal_agents_match_the_prd():
    handoffs, tools = _graph(init_agents())
    assert handoffs == HANDOFFS
    assert tools == TEMPORAL_TOOLS


def test_standalone_agents_match_the_prd():
    handoffs, tools = _graph(standalone.supervisor_agent)
    assert handoffs == HANDOFFS
    assert tools == STANDALONE_TOOLS


def _flat(text: str) -> str:
    return " ".join(text.split())


def test_open_account_prompt_has_the_prd_lines_word_for_word():
    prompt = _flat(agent_constants.OPEN_ACCOUNT_INSTRUCTIONS)
    for line in [
        "Never state the status of an account opening from memory or from the conversation history: it "
        "changes without you being told. Whenever you need it, call get_account_opening_status with the "
        "workflow ID returned by open_new_investment_account.",
        "Every request to open an account starts a new account opening: call open_new_investment_account "
        "each time, even if an account with the same name was opened, or is still being opened, earlier in "
        "this conversation. Don't ask the customer whether they want another one. Never answer a request to "
        "open an account from the conversation history.",
        "Every account opening needs its own KYC confirmation, even if the customer confirmed their details "
        "for an earlier one in this conversation.",
    ]:
        assert line in prompt
