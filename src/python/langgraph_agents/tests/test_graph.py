"""The conversation graph, run with plain LangGraph (no Temporal) and the scripted model.

Checks the routing: handoffs move the conversation to another agent's node in the same customer
message, the next message starts at the agent that answered last, tools run and their output goes
back to the model, and a model that keeps calling tools gives up.
"""

import uuid

import pytest

from lg_agents.agents import AgentContext, all_agents, build_agents, function_tool
from lg_agents.graph import GIVE_UP, MAX_MODEL_CALLS, build_graph, reply_text, tools_node, turn_input
from lg_agents import llm
from langchain_core.messages import HumanMessage
from prompts.agent_constants import (BENE_AGENT_NAME, INVEST_AGENT_NAME, INVEST_INSTRUCTIONS,
                                     SUPERVISOR_AGENT_NAME)
from tests.scripted_model import INSTRUCTIONS, SCRIPT, handoff, message, tool

ACCOUNTS = [{"name": "Checking", "balance": 1000.0}]


@function_tool("List the investment accounts.", client_id="The customer's client ID")
async def list_investments(client_id: str) -> list:
    return ACCOUNTS


@function_tool("Close an investment account.", client_id="The customer's client ID", investment_id="The ID")
async def close_investment(client_id: str, investment_id: str) -> str:
    raise ValueError("core banking is down")


@function_tool("List beneficiaries.", client_id="The customer's client ID")
async def list_beneficiaries(client_id: str) -> list:
    return []


@pytest.fixture
def chat():
    """Runs customer messages through the graph, keeping the conversation like the callers do."""
    supervisor = build_agents([list_beneficiaries], [list_investments, close_investment], [])
    context = AgentContext()
    state = {"messages": [], "agent": supervisor.name}

    async def model(system, messages, tools):
        return await llm.complete(system, messages, tools)

    app = build_graph(supervisor, model, tools_node(all_agents(supervisor), lambda: context,
                                                    new_id=lambda: str(uuid.uuid4()))).compile()

    async def say(text: str) -> dict:
        start = len(state["messages"])
        result = await app.ainvoke(turn_input([*state["messages"], HumanMessage(text)], state["agent"], context))
        state["messages"], state["agent"] = result["messages"], result["active_agent"]
        return {**result, "reply": reply_text(result["messages"], start + 1)}

    say.context = context
    return say


async def test_a_handoff_and_a_tool_call_answer_the_same_message(chat):
    SCRIPT[:] = [handoff(INVEST_AGENT_NAME), tool("list_investments", client_id="123"), message("You have Checking.")]
    result = await chat("What accounts do I have? My client ID is 123.")

    assert result["reply"] == "You have Checking."
    assert result["active_agent"] == INVEST_AGENT_NAME
    assert result["trace"] == [f"Handed off from {SUPERVISOR_AGENT_NAME} to {INVEST_AGENT_NAME}",
                               f"{INVEST_AGENT_NAME}: Calling a tool"]
    assert result["tool_outputs"] == ['[{"name": "Checking", "balance": 1000.0}]']
    assert result["model_calls"] == 3
    # The Investment Agent answered after the handoff, and was told the client ID once a tool used it.
    assert INSTRUCTIONS[1].startswith(INVEST_INSTRUCTIONS)
    assert "client ID is 123" in INSTRUCTIONS[2]
    assert chat.context.client_id == "123"
    assert SCRIPT == []


async def test_the_next_message_starts_at_the_agent_that_answered_last(chat):
    SCRIPT[:] = [handoff(INVEST_AGENT_NAME), message("Which account?"), message("Done.")]
    await chat("Close an account.")
    result = await chat("Checking.")

    assert result["reply"] == "Done."
    assert INSTRUCTIONS[-1].startswith(INVEST_INSTRUCTIONS)
    assert result["trace"] == []


async def test_handing_back_to_the_supervisor_and_on_to_another_agent(chat):
    SCRIPT[:] = [handoff(INVEST_AGENT_NAME), handoff(SUPERVISOR_AGENT_NAME), handoff(BENE_AGENT_NAME),
                 message("You have no beneficiaries.")]
    result = await chat("Who are my beneficiaries?")

    assert result["active_agent"] == BENE_AGENT_NAME
    assert [line.split(" to ")[-1] for line in result["trace"]] == [INVEST_AGENT_NAME, SUPERVISOR_AGENT_NAME,
                                                                     BENE_AGENT_NAME]


async def test_tool_errors_and_bad_arguments_go_back_to_the_model(chat):
    SCRIPT[:] = [handoff(INVEST_AGENT_NAME), tool("close_investment", client_id="123", investment_id="9"),
                 tool("list_investments"), message("Sorry, that didn't work.")]
    result = await chat("Close account 9.")

    assert result["tool_outputs"][0] == "Error: core banking is down"
    assert result["tool_outputs"][1].startswith("Error: invalid arguments for list_investments")
    assert result["reply"] == "Sorry, that didn't work."


async def test_a_model_that_keeps_calling_tools_gives_up(chat):
    SCRIPT[:] = [handoff(INVEST_AGENT_NAME)] + [tool("list_investments", client_id="123")] * (MAX_MODEL_CALLS - 1)
    result = await chat("List my accounts.")

    assert result["model_calls"] == MAX_MODEL_CALLS
    assert result["reply"] == GIVE_UP
    assert SCRIPT == []
