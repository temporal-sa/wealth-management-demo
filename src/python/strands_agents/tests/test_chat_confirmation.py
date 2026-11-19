"""Deleting a beneficiary is confirmed in the chat, as in the other frameworks.

Runs the real ``WealthManagementWorkflow`` in a local Temporal environment, with a
deterministic scripted model (registered under the production model name) and
lightweight stub activities that record side effects instead of touching Redis or
the data files.

The first call to delete_beneficiary is refused (ConfirmationGuard), so the agent
asks the customer to confirm and the turn ends with that question in the chat.
The customer's next message answers it:

  - "Yes" -> the delete activity runs exactly once
  - "No"  -> the delete activity never runs

The guard itself (``confirmed``) is checked directly too, including a call in the
same turn as the question, which must be refused.

Requires the Temporal test server (downloaded automatically on first run). No
GEMINI_API_KEY or Redis needed.
"""

import asyncio
import itertools
import json
import uuid
from collections.abc import AsyncIterable
from typing import Any

import pytest
from temporalio import activity
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker
from temporalio.contrib.strands import StrandsPlugin

from strands.models import Model
from strands.types.content import Messages, SystemContentBlock
from strands.types.streaming import StreamEvent
from strands.types.tools import ToolChoice, ToolSpec

from common.user_message import ProcessUserMessageInput
from durable.model_config import LLM_TASK_QUEUE
from durable.workflows.supervisor_workflow import WealthManagementWorkflow, confirmed

TASK_QUEUE = "test-chat-confirmation"
CLIENT_ID = "C-1"
BENE_ID = "b1"
DELETE_REQUEST = f"Please delete beneficiary {BENE_ID} for client {CLIENT_ID}"
DECLINED = "Okay, I did not delete the beneficiary."

# Records real deletes worker-side (same process as the test).
DELETE_CALLS: list = []
# When set, the beneficiary agent calls delete_beneficiary again right after it is
# refused, in the same turn, instead of asking the customer.
RETRY_IN_SAME_TURN = {"on": False}

_tool_use_ids = itertools.count()


# --------------------------------------------------------------------------- #
# Scripted model: drives supervisor -> beneficiary_assistant -> delete_beneficiary.
# One factory registered under the production model name, so the real workflow's
# TemporalAgent(model=MODEL_NAME) picks it up. It decides what to emit from the
# tools it is offered and the messages since the customer's latest message.
# --------------------------------------------------------------------------- #
def _texts(message: dict) -> list[str]:
    return [block["text"] for block in message.get("content", []) if isinstance(block, dict) and "text" in block]


def _current_turn(messages: Messages) -> Messages:
    """The messages since the latest user message that carries text (not a tool result)."""
    for index in range(len(messages) - 1, -1, -1):
        if messages[index]["role"] == "user" and _texts(messages[index]):
            return messages[index:]
    return messages


def _tool_results(turn: Messages) -> list[str]:
    return [
        " ".join(item.get("text", "") for item in block["toolResult"].get("content", []))
        for message in turn
        for block in message.get("content", [])
        if isinstance(block, dict) and "toolResult" in block
    ]


def _tool_use_events(name: str, tool_input: dict) -> list[StreamEvent]:
    return [
        {"messageStart": {"role": "assistant"}},
        {"contentBlockStart": {"contentBlockIndex": 0,
                               "start": {"toolUse": {"name": name, "toolUseId": f"tu-{next(_tool_use_ids)}"}}}},
        {"contentBlockDelta": {"contentBlockIndex": 0,
                               "delta": {"toolUse": {"input": json.dumps(tool_input)}}}},
        {"contentBlockStop": {"contentBlockIndex": 0}},
        {"messageStop": {"stopReason": "tool_use"}},
    ]


def _text_events(text: str) -> list[StreamEvent]:
    return [
        {"messageStart": {"role": "assistant"}},
        {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"text": text}}},
        {"contentBlockStop": {"contentBlockIndex": 0}},
        {"messageStop": {"stopReason": "end_turn"}},
    ]


def _supervisor(turn: Messages) -> list[StreamEvent]:
    if results := _tool_results(turn):
        return _text_events(results[-1])  # relay the specialist's answer
    customer = " ".join(_texts(turn[0])).strip().lower()
    if customer.startswith("no"):
        return _text_events(DECLINED)
    request = f"delete beneficiary {BENE_ID}"
    if customer.startswith("yes"):
        request += ". The customer confirmed it."
    return _tool_use_events("beneficiary_assistant", {"client_id": CLIENT_ID, "request": request})


def _beneficiary_agent(turn: Messages) -> list[StreamEvent]:
    results = _tool_results(turn)
    if not results or (RETRY_IN_SAME_TURN["on"] and len(results) == 1):
        return _tool_use_events("delete_beneficiary", {"client_id": CLIENT_ID, "beneficiary_id": BENE_ID})
    return _text_events(results[-1])


class ScriptedModel(Model):
    def update_config(self, **_kw: Any) -> None:
        return None

    def get_config(self) -> dict:
        return {}

    def structured_output(self, *_a: Any, **_k: Any) -> Any:
        raise NotImplementedError

    async def stream(
        self,
        messages: Messages,
        tool_specs: list[ToolSpec] | None = None,
        system_prompt: str | None = None,
        *,
        tool_choice: ToolChoice | None = None,
        system_prompt_content: list[SystemContentBlock] | None = None,
        invocation_state: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> AsyncIterable[StreamEvent]:
        names = {ts["name"] for ts in (tool_specs or [])}
        turn = _current_turn(messages)
        if "beneficiary_assistant" in names:
            events = _supervisor(turn)
        elif "delete_beneficiary" in names:
            events = _beneficiary_agent(turn)
        else:
            events = _text_events("All done.")

        for event in events:
            yield event
        yield {"metadata": {"usage": {"inputTokens": 1, "outputTokens": 1, "totalTokens": 2},
                            "metrics": {"latencyMs": 1}}}


MODELS = {"gemini": lambda: ScriptedModel()}  # MODEL_NAME in model_config is "gemini"


# --------------------------------------------------------------------------- #
# Stub activities: same @activity.defn names as the real ones (Temporal resolves
# by name), so the real workflow runs unchanged while we record side effects and
# avoid Redis / data-file writes.
# --------------------------------------------------------------------------- #
@activity.defn(name="list_beneficiaries")
async def stub_list_beneficiaries(client_id: str) -> list:
    return [{"id": BENE_ID, "first_name": "Sam", "last_name": "Doe", "relationship": "spouse"}]


@activity.defn(name="add_beneficiary")
async def stub_add_beneficiary(client_id: str, first_name: str, last_name: str, relationship: str) -> str:
    return "added"


@activity.defn(name="delete_beneficiary")
async def stub_delete_beneficiary(client_id: str, beneficiary_id: str) -> str:
    DELETE_CALLS.append((client_id, beneficiary_id))
    return f"Beneficiary {beneficiary_id} deleted successfully."


@activity.defn(name="list_investments")
async def stub_list_investments(client_id: str) -> list:
    return []


@activity.defn(name="close_investment")
async def stub_close_investment(client_id: str, investment_id: str) -> str:
    return "closed"


@activity.defn(name="append_chat_interaction")
async def stub_append_chat_interaction(workflow_id: str, chat_interaction: Any) -> int:
    return 0


@activity.defn(name="append_status_update")
async def stub_append_status_update(workflow_id: str, status_update: Any) -> int:
    return 0


@activity.defn(name="delete_conversation")
async def stub_delete_conversation(workflow_id: str) -> bool:
    return True


STUB_ACTIVITIES = [
    stub_list_beneficiaries, stub_add_beneficiary, stub_delete_beneficiary,
    stub_list_investments, stub_close_investment,
    stub_append_chat_interaction, stub_append_status_update, stub_delete_conversation,
]


async def wait_for_reply(handle, count: int) -> str:
    """The assistant's reply once the chat history has ``count`` interactions."""
    for _ in range(160):
        history = await handle.query(WealthManagementWorkflow.get_chat_history)
        if len(history) >= count:
            return history[count - 1].text_response
        await asyncio.sleep(0.25)
    raise AssertionError(f"no reply number {count}")


async def _run_conversation(env: WorkflowEnvironment, messages: list[str]) -> list[str]:
    """Sends each customer message in turn and returns the assistant's replies."""
    DELETE_CALLS.clear()
    client = env.client
    # The plugin registers the model activities on both workers; the agents
    # schedule them on LLM_TASK_QUEUE.
    async with Worker(
        client,
        task_queue=TASK_QUEUE,
        workflows=[WealthManagementWorkflow],
        activities=STUB_ACTIVITIES,
    ), Worker(client, task_queue=LLM_TASK_QUEUE):
        handle = await client.start_workflow(
            WealthManagementWorkflow.run,
            id=f"confirm-{uuid.uuid4()}",
            task_queue=TASK_QUEUE,
        )
        replies = []
        for number, message in enumerate(messages, start=1):
            await handle.signal(
                WealthManagementWorkflow.process_user_message,
                ProcessUserMessageInput(user_input=message),
            )
            replies.append(await wait_for_reply(handle, number))
        await handle.signal(WealthManagementWorkflow.end_workflow)
        await asyncio.wait_for(handle.result(), timeout=10)
        return replies


@pytest.fixture(scope="module")
async def temporal_env():
    async with await WorkflowEnvironment.start_local(
        plugins=[StrandsPlugin(models=MODELS)]
    ) as env:
        yield env


def test_a_delete_runs_only_when_confirmed_in_the_next_message():
    assert not confirmed(None, 1)  # never asked
    assert confirmed(1, 2)  # asked, and this is the customer's next message
    assert not confirmed(2, 2)  # asked in this same turn
    assert not confirmed(1, 3)  # asked earlier in the conversation, not just now


async def test_yes_in_the_next_message_runs_the_delete(temporal_env):
    question, answer = await _run_conversation(temporal_env, [DELETE_REQUEST, "Yes"])
    assert "has not confirmed" in question  # the turn ends with a request to confirm
    assert answer == f"Beneficiary {BENE_ID} deleted successfully."
    assert DELETE_CALLS == [(CLIENT_ID, BENE_ID)], "delete must run once, after the confirmation"


async def test_no_in_the_next_message_blocks_the_delete(temporal_env):
    question, answer = await _run_conversation(temporal_env, [DELETE_REQUEST, "No"])
    assert "has not confirmed" in question
    assert answer == DECLINED
    assert DELETE_CALLS == [], "delete must NOT run after the customer says no"


async def test_calling_again_in_the_same_turn_is_still_refused(temporal_env):
    RETRY_IN_SAME_TURN["on"] = True
    try:
        (reply,) = await _run_conversation(temporal_env, [DELETE_REQUEST])
    finally:
        RETRY_IN_SAME_TURN["on"] = False
    assert "has not confirmed" in reply
    assert DELETE_CALLS == [], "the customer hasn't answered yet, so nothing is deleted"


if __name__ == "__main__":
    # Allow running standalone without pytest.
    async def _main():
        async with await WorkflowEnvironment.start_local(
            plugins=[StrandsPlugin(models=MODELS)]
        ) as env:
            print("YES:", await _run_conversation(env, [DELETE_REQUEST, "Yes"]), DELETE_CALLS)
            print("NO: ", await _run_conversation(env, [DELETE_REQUEST, "No"]), DELETE_CALLS)

    asyncio.run(_main())
