"""Once a tool has been called with the customer's client ID, every agent is told the
ID, so an agent the conversation is handed to doesn't ask for it again.

Runs the real ``WealthManagementWorkflow`` with a scripted model, which records the
instructions each agent was given, and stub activities registered under the real
activity names.

Requires the Temporal test server (downloaded automatically on first run). No model
key or Redis needed.
"""

import uuid

from temporalio import activity
from temporalio.worker import Worker

import tests.scripted_model as scripted_model
from common.agent_constants import INVEST_AGENT_NAME, OPEN_ACCOUNT_AGENT_NAME, OPEN_ACCOUNT_INSTRUCTIONS
from temporal_supervisor.activities.event_stream_activities import EventStreamActivities, InMemoryEventStream
from temporal_supervisor.workflows.supervisor_workflow import WealthManagementWorkflow
from tests.scripted_model import handoff, message, model_worker, send, tool

TASK_QUEUE = "test-client-id"
CLIENT_ID_NOTE = "The customer's client ID is 123"


@activity.defn(name="list_investments")
async def stub_list_investments(client_id: str) -> list:
    return [{"investment_id": "i-1", "name": "Checking", "balance": 1000.0}]


async def test_agents_are_told_the_client_id_once_a_tool_has_used_it(temporal_env):
    client = temporal_env.client
    events = EventStreamActivities(InMemoryEventStream())
    scripted_model.INSTRUCTIONS.clear()
    scripted_model.SCRIPT[:] = [
        # "What investments do I have?"
        message("What is your client ID?"),
        # "123"
        handoff(INVEST_AGENT_NAME),
        tool("list_investments", client_id="123"),
        message("You have a Checking account."),
        # "Open Car with 10,000"
        handoff(OPEN_ACCOUNT_AGENT_NAME),
        message("Opening it now."),
    ]

    async with Worker(
        client,
        task_queue=TASK_QUEUE,
        workflows=[WealthManagementWorkflow],
        activities=[stub_list_investments, events.delete_conversation, events.append_chat_interaction],
    ), model_worker(client):
        handle = await client.start_workflow(
            WealthManagementWorkflow.run, id=f"client-id-test-{uuid.uuid4()}", task_queue=TASK_QUEUE
        )
        await send(handle, "What investments do I have?")
        await send(handle, "123")
        reply = await send(handle, "Open Car with 10,000")
        assert reply.agent_trace == f"Handed off from {INVEST_AGENT_NAME} to {OPEN_ACCOUNT_AGENT_NAME}\n"
        assert scripted_model.SCRIPT == []
        await handle.signal(WealthManagementWorkflow.end_workflow)
        await handle.result()

    instructions = scripted_model.INSTRUCTIONS
    # Until list_investments is called, the ID is only in the conversation.
    assert not any(CLIENT_ID_NOTE in i for i in instructions[:3])
    # From the model call right after it, every agent is told the ID, including the
    # Open Account Agent the conversation is then handed to.
    assert all(CLIENT_ID_NOTE in i for i in instructions[3:])
    assert OPEN_ACCOUNT_INSTRUCTIONS in instructions[-1]
