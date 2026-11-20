"""The standalone version: the four agents as a command-line chat, with plain LangGraph.

No Temporal: the same graph as the Temporal version (lg_agents.graph) runs in this process. The
agent nodes call Gemini and the tools call the data managers directly. Accounts are opened directly
by a tool, so there is no KYC, compliance review or saga, and nothing survives a crash or an outage.

Run it from this folder with ./startchat.sh, or from the framework folder with:

    uv run python -m standalone.main
"""

import asyncio
import uuid

from langchain_core.messages import AnyMessage, HumanMessage

from common.beneficiaries_manager import BeneficiariesManager
from common.gemini_model import gemini_model
from common.investment_manager import InvestmentAccount, InvestmentManager
from lg_agents import llm
from lg_agents.agents import AgentContext, all_agents, build_agents, function_tool
from lg_agents.graph import build_graph, reply_text, tools_node, turn_input
from prompts.agent_constants import MAX_INITIAL_DEPOSIT, MIN_INITIAL_DEPOSIT, STANDALONE_OPEN_ACCOUNT_INSTRUCTIONS

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
    initial_amount = float(initial_amount)
    if initial_amount < MIN_INITIAL_DEPOSIT:
        return f"The account cannot be opened: the initial deposit must be at least ${MIN_INITIAL_DEPOSIT:,.2f}"
    if initial_amount > MAX_INITIAL_DEPOSIT:
        return (f"The account cannot be opened: initial deposits over ${MAX_INITIAL_DEPOSIT:,.2f} cannot be "
                "opened online and must be arranged with a wealth advisor")
    return investment_acct_mgr.add_investment_account(InvestmentAccount(client_id, account_name, initial_amount))

### The graph

supervisor_agent = build_agents(
    beneficiary_tools=[list_beneficiaries, add_beneficiary, delete_beneficiary],
    investment_tools=[list_investments, close_investment],
    open_account_tools=[open_new_investment_account],
    open_account_instructions=STANDALONE_OPEN_ACCOUNT_INSTRUCTIONS,
)
context = AgentContext()


async def call_model(system: str, messages: list[AnyMessage], tools: list[dict]):
    # Without Temporal, LangChain's own retries are all there is.
    return await llm.complete(system, messages, tools, max_retries=3)


app = build_graph(
    supervisor_agent,
    call_model=call_model,
    tools=tools_node(all_agents(supervisor_agent), lambda: context, new_id=lambda: str(uuid.uuid4())),
).compile()


async def main():
    current_agent = supervisor_agent.name
    messages: list[AnyMessage] = []

    print(f"Using model {gemini_model()}. Type exit, end or quit to leave.")
    print("Welcome to ABC Wealth Management. How can I help you?")
    while True:
        try:
            user_input = input("Enter your message: ")
        except EOFError:
            break
        if user_input.strip().lower() in ("exit", "end", "quit"):
            break
        turn_start = len(messages)
        try:
            result = await app.ainvoke(turn_input([*messages, HumanMessage(user_input)], current_agent, context))
        except Exception as e:
            # Without Temporal, a failed model call loses the turn: the customer has to try again.
            print(f"Error: {e}")
            continue
        messages = result["messages"]
        current_agent = result["active_agent"]
        for line in result["trace"]:
            print(f"  [{line}]")
        print(f"{current_agent}: {reply_text(messages, turn_start + 1)}")


if __name__ == "__main__":
    asyncio.run(main())
