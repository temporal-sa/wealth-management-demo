"""The standalone version: the four agents as a command-line chat, in plain Python.

No Temporal and no agent framework: the shared agent loop (common.agent_loop) calls the
model through LiteLLM and the tools call the data managers directly. Accounts are
opened directly by a tool, so there is no KYC, compliance review or saga, and nothing
survives a crash or an outage.

Run it from this folder with ./startchat.sh, or from the repository root with:

    uv run python -m pure_supervisor.main
"""

import asyncio
import logging

from common.agent_constants import MAX_INITIAL_DEPOSIT, MIN_INITIAL_DEPOSIT, STANDALONE_OPEN_ACCOUNT_INSTRUCTIONS
from common.agent_loop import Agent, AgentContext, ModelRequest, ModelResponse, function_tool, run_turn
from common.beneficiaries_manager import BeneficiariesManager
from common.investment_manager import InvestmentAccount, InvestmentManager
from common.llm import complete
from common.llm_config import llm_model
from common.wealth_agents import build_agents

logger = logging.getLogger(__name__)

### Managers

investment_acct_mgr = InvestmentManager()
beneficiaries_mgr = BeneficiariesManager()

### Tools

CLIENT_ID = "The customer's client ID"


@function_tool("List the beneficiaries for the given client ID.", client_id=CLIENT_ID)
async def list_beneficiaries(client_id: str) -> list:
    return beneficiaries_mgr.list_beneficiaries(client_id)


@function_tool("Add a beneficiary for the given client ID.", client_id=CLIENT_ID,
               first_name="The beneficiary's first name", last_name="The beneficiary's last name",
               relationship="The beneficiary's relationship to the customer, such as son or spouse")
async def add_beneficiary(client_id: str, first_name: str, last_name: str, relationship: str) -> str:
    beneficiaries_mgr.add_beneficiary(client_id, first_name, last_name, relationship)
    return f"Beneficiary {first_name} {last_name} added."


@function_tool("Delete a beneficiary by its beneficiary ID.", client_id=CLIENT_ID,
               beneficiary_id="The beneficiary ID from list_beneficiaries")
async def delete_beneficiary(client_id: str, beneficiary_id: str) -> str:
    beneficiaries_mgr.delete_beneficiary(client_id, beneficiary_id)
    return f"Beneficiary {beneficiary_id} deleted."


@function_tool("List the investment accounts and balances for the given client ID.", client_id=CLIENT_ID)
async def list_investments(client_id: str) -> list:
    return investment_acct_mgr.list_investment_accounts(client_id)


@function_tool("Close an investment account by its investment ID.", client_id=CLIENT_ID,
               investment_id="The investment ID from list_investments")
async def close_investment(client_id: str, investment_id: str) -> str:
    # A real close would be much more involved, and would not delete the account record.
    investment_acct_mgr.delete_investment_account(client_id, investment_id)
    return f"Investment account {investment_id} closed."


@function_tool("Open a new investment account. Returns the new account, or the reason it cannot be opened.",
               client_id=CLIENT_ID, account_name="The name for the new investment account",
               initial_amount="The initial deposit amount")
async def open_new_investment_account(client_id: str, account_name: str, initial_amount: float) -> dict | str:
    if initial_amount < MIN_INITIAL_DEPOSIT:
        return f"The account cannot be opened: the initial deposit must be at least ${MIN_INITIAL_DEPOSIT:,.2f}"
    if initial_amount > MAX_INITIAL_DEPOSIT:
        return (f"The account cannot be opened: initial deposits over ${MAX_INITIAL_DEPOSIT:,.2f} cannot be "
                "opened online and must be arranged with a wealth advisor")
    return investment_acct_mgr.add_investment_account(InvestmentAccount(client_id, account_name, float(initial_amount)))

### Agents

supervisor_agent: Agent = build_agents(
    beneficiary_tools=[list_beneficiaries, add_beneficiary, delete_beneficiary],
    investment_tools=[list_investments, close_investment],
    open_account_tools=[open_new_investment_account],
    open_account_instructions=STANDALONE_OPEN_ACCOUNT_INSTRUCTIONS,
)


async def call_model(request: ModelRequest) -> ModelResponse:
    # Without Temporal, LiteLLM's own retries are all there is.
    return await complete(request, num_retries=3)


async def main():
    current_agent = supervisor_agent
    messages: list[dict] = []
    context = AgentContext()

    print(f"Using model {llm_model()}. Type exit, end or quit to leave.")
    print("Welcome to ABC Wealth Management. How can I help you?")
    while True:
        try:
            user_input = input("Enter your message: ")
        except EOFError:
            break
        if user_input.strip().lower() in ("exit", "end", "quit"):
            break
        turn_start = len(messages)
        messages.append({"role": "user", "content": user_input})
        try:
            result = await run_turn(current_agent, messages, context, call_model)
        except Exception as e:
            # Without Temporal, a failed model call loses the turn: drop it and let the customer retry.
            del messages[turn_start:]
            print(f"Error: {e}")
            continue
        for line in result.agent_trace.splitlines():
            print(f"  [{line}]")
        print(f"{result.agent.name}: {result.text_response}")
        current_agent = result.agent


if __name__ == "__main__":
    asyncio.run(main())
