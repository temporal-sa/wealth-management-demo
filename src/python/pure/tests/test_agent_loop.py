"""The agent loop on its own, without Temporal: handoffs in the same turn, tool calls,
tool errors, and the client ID shared by every agent."""

import json

import pytest

from common.agent_loop import Agent, AgentContext, ModelResponse, ToolCall, function_tool, run_turn


@function_tool("List the customer's accounts.", client_id="The customer's client ID")
async def list_accounts(client_id: str) -> list:
    if client_id == "bad":
        raise ValueError("no such client")
    return [{"name": "Checking"}]


@function_tool("Remember a note.", note="The note")
async def remember(ctx: AgentContext, note: str, tag: str | None = None) -> None:
    ctx.notes = [*getattr(ctx, "notes", []), (note, tag)]


def _agents():
    specialist = Agent("Account Agent", "Lists accounts.", "You list accounts.", [list_accounts, remember])
    supervisor = Agent("Supervisor Agent", "Routes.", "You route.", handoffs=[specialist])
    specialist.handoffs.append(supervisor)
    return supervisor, specialist


def _scripted(*responses):
    """A model that replays responses and records the requests it got."""
    requests = []

    async def call_model(request):
        requests.append(request)
        return responses[len(requests) - 1]
    return call_model, requests


def _call(name, **arguments):
    return ModelResponse(tool_calls=[ToolCall(id=f"call-{name}", name=name, arguments=json.dumps(arguments))])


def test_tool_schema_comes_from_the_signature():
    assert list_accounts.parameters == {
        "type": "object",
        "properties": {"client_id": {"type": "string", "description": "The customer's client ID"}},
        "required": ["client_id"],
    }
    # ctx is not shown to the model, and a parameter with a default is optional.
    assert remember.takes_context
    assert list(remember.parameters["properties"]) == ["note", "tag"]
    assert remember.parameters["required"] == ["note"]


async def test_handoff_continues_in_the_same_turn_with_the_new_agent():
    supervisor, specialist = _agents()
    call_model, requests = _scripted(
        _call("transfer_to_account_agent"),
        _call("list_accounts", client_id="123"),
        ModelResponse(content="You have a Checking account."),
    )
    messages = [{"role": "user", "content": "What accounts do I have? I'm 123."}]
    context = AgentContext()

    result = await run_turn(supervisor, messages, context, call_model)

    assert result.agent is specialist
    assert result.text_response == "You have a Checking account."
    assert result.agent_trace == ("Handed off from Supervisor Agent to Account Agent\n"
                                  "Account Agent: Calling a tool\n")
    assert result.json_response == '[{"name": "Checking"}]\n'
    # The first call goes to the supervisor, the rest to the specialist, in one turn.
    assert [r.system for r in requests][0] == "You route."
    assert all(r.system.startswith("You list accounts.") for r in requests[1:])
    assert [t["function"]["name"] for t in requests[0].tools] == ["transfer_to_account_agent"]
    # Every tool call gets a result, and the conversation ends with the reply.
    assert [m["role"] for m in messages] == ["user", "assistant", "tool", "assistant", "tool", "assistant"]
    assert messages[2]["content"] == json.dumps({"assistant": "Account Agent"})


async def test_client_id_is_saved_before_the_tool_runs_and_told_to_every_agent():
    supervisor, _ = _agents()
    call_model, requests = _scripted(
        _call("transfer_to_account_agent"),
        _call("list_accounts", client_id="123"),
        _call("transfer_to_supervisor_agent"),
        ModelResponse(content="Anything else?"),
    )
    context = AgentContext()
    await run_turn(supervisor, [{"role": "user", "content": "hi"}], context, call_model)

    note = "The customer's client ID is 123. Use it, and don't ask for it again."
    assert context.client_id == "123"
    assert [note in r.system for r in requests] == [False, False, True, True]


async def test_tool_errors_and_bad_calls_go_back_to_the_model():
    _, specialist = _agents()
    call_model, _ = _scripted(
        ModelResponse(tool_calls=[
            ToolCall(id="1", name="list_accounts", arguments='{"client_id": "bad"}'),
            ToolCall(id="2", name="no_such_tool", arguments="{}"),
            ToolCall(id="3", name="list_accounts", arguments="not json"),
            ToolCall(id="4", name="list_accounts", arguments='{"account": "x"}'),
            ToolCall(id="5", name="remember", arguments='{"note": "likes bonds"}'),
        ]),
        ModelResponse(content="Sorry about that."),
    )
    messages = [{"role": "user", "content": "hi"}]
    context = AgentContext()
    result = await run_turn(specialist, messages, context, call_model)

    outputs = {m["tool_call_id"]: m["content"] for m in messages if m["role"] == "tool"}
    assert outputs["1"] == "Error: no such client"
    assert outputs["2"].startswith("Error: there is no tool named no_such_tool")
    assert outputs["3"].startswith("Error: the arguments for list_accounts are not valid JSON")
    assert outputs["4"].startswith("Error: invalid arguments for list_accounts")
    assert outputs["5"] == "Done."
    assert context.notes == [("likes bonds", None)]
    assert result.text_response == "Sorry about that."


async def test_errors_not_listed_as_tool_errors_propagate():
    _, specialist = _agents()
    call_model, _ = _scripted(_call("list_accounts", client_id="bad"))
    with pytest.raises(ValueError):
        await run_turn(specialist, [{"role": "user", "content": "hi"}], AgentContext(), call_model,
                       tool_errors=(KeyError,))


async def test_only_the_first_handoff_in_a_response_is_followed():
    supervisor, specialist = _agents()
    call_model, _ = _scripted(
        ModelResponse(tool_calls=[ToolCall(id="1", name="transfer_to_account_agent", arguments="{}"),
                                  ToolCall(id="2", name="transfer_to_account_agent", arguments="{}")]),
        ModelResponse(content="Hello."),
    )
    messages = [{"role": "user", "content": "hi"}]
    result = await run_turn(supervisor, messages, AgentContext(), call_model)
    assert result.agent is specialist
    assert result.agent_trace.count("Handed off") == 1
    assert messages[3]["content"].startswith("Ignored")


async def test_a_turn_that_never_ends_is_cut_off():
    _, specialist = _agents()

    async def call_model(request):
        return _call("list_accounts", client_id="123")

    result = await run_turn(specialist, [{"role": "user", "content": "hi"}], AgentContext(), call_model,
                            max_model_calls=3)
    assert result.text_response.startswith("Sorry, I wasn't able to finish")
