"""The four agents and their handoffs, shared by the standalone and Temporal versions.

Each version supplies the tools: the standalone version's call the data managers
directly, the Temporal version's run activities.

    Supervisor Agent  -> Beneficiary Agent, Investment Agent
    Beneficiary Agent -> Supervisor Agent
    Investment Agent  -> Open Account Agent, Supervisor Agent
    Open Account Agent -> Investment Agent
"""

from common.agent_constants import (
    BENE_AGENT_NAME, BENE_HANDOFF, BENE_INSTRUCTIONS,
    INVEST_AGENT_NAME, INVEST_HANDOFF, INVEST_INSTRUCTIONS,
    OPEN_ACCOUNT_AGENT_NAME, OPEN_ACCOUNT_HANDOFF, OPEN_ACCOUNT_INSTRUCTIONS,
    SUPERVISOR_AGENT_NAME, SUPERVISOR_HANDOFF, SUPERVISOR_INSTRUCTIONS,
)
from common.agent_loop import Agent, Tool


def build_agents(
    beneficiary_tools: list[Tool],
    investment_tools: list[Tool],
    open_account_tools: list[Tool],
    open_account_instructions: str = OPEN_ACCOUNT_INSTRUCTIONS,
) -> Agent:
    """Create the agents and return the Supervisor Agent, which takes the first message."""
    beneficiary_agent = Agent(BENE_AGENT_NAME, BENE_HANDOFF, BENE_INSTRUCTIONS, beneficiary_tools)
    investment_agent = Agent(INVEST_AGENT_NAME, INVEST_HANDOFF, INVEST_INSTRUCTIONS, investment_tools)
    open_account_agent = Agent(OPEN_ACCOUNT_AGENT_NAME, OPEN_ACCOUNT_HANDOFF, open_account_instructions,
                               open_account_tools)
    supervisor_agent = Agent(SUPERVISOR_AGENT_NAME, SUPERVISOR_HANDOFF, SUPERVISOR_INSTRUCTIONS,
                             handoffs=[beneficiary_agent, investment_agent])

    beneficiary_agent.handoffs.append(supervisor_agent)
    investment_agent.handoffs.extend([open_account_agent, supervisor_agent])
    open_account_agent.handoffs.append(investment_agent)
    return supervisor_agent
