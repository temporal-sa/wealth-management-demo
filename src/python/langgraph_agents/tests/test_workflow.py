"""The real chat workflow, with Temporal's LangGraph plugin and the scripted model.

Checks that each agent node runs as an activity on the model task queue, that the tools node's
tools run as activities in the workflow, and that approve_kyc only approves KYC after the customer
has seen and confirmed their details for that account opening (the guard runs in the tools node,
on the workflow's state).

Requires the Temporal test server (downloaded automatically on first run). No model key or Redis.
"""

import uuid

import pytest
from temporalio import activity
from temporalio.api.enums.v1 import EventType

from durable.activities.event_stream_activities import EventStreamActivities, InMemoryEventStream
from durable.task_queues import TASK_QUEUE_LLM
from durable.workflows.chat_graph import GRAPH_NAME, WealthManagementContext, approve_kyc
from durable.workflows.supervisor_workflow import WealthManagementWorkflow
from prompts.agent_constants import INVEST_AGENT_NAME, OPEN_ACCOUNT_AGENT_NAME
from tests.scripted_model import SCRIPT, handoff, message, send, tool, workers

TASK_QUEUE = "test-langgraph-chat"
WORKFLOW_ID = "OpenAccount-test-123-Education-2"


@activity.defn(name="list_investments")
async def stub_list_investments(client_id: str) -> list:
    return [{"investment_id": "i-1", "client_id": client_id, "name": "Checking", "balance": 1000.0}]


async def test_agent_nodes_run_as_activities_on_the_model_queue(temporal_env):
    client = temporal_env.client
    events = EventStreamActivities(InMemoryEventStream())
    SCRIPT[:] = [handoff(INVEST_AGENT_NAME), tool("list_investments", client_id="123"),
                 message("Here are your investment accounts:\n\n1. **Checking:** $1,000.00")]

    async with workers(client, TASK_QUEUE, [stub_list_investments, events.delete_conversation,
                                            events.append_chat_interaction]):
        handle = await client.start_workflow(WealthManagementWorkflow.run, id=f"lg-test-{uuid.uuid4()}",
                                             task_queue=TASK_QUEUE)
        reply = await send(handle, "What accounts do I have? My client ID is 123.")
        assert reply.text_response.endswith("**Checking:** $1,000.00")
        assert reply.agent_trace == (f"Handed off from Supervisor Agent to {INVEST_AGENT_NAME}\n"
                                     f"{INVEST_AGENT_NAME}: Calling a tool\n")
        assert "Checking" in reply.json_response

        await handle.signal(WealthManagementWorkflow.end_workflow)
        await handle.result()

        scheduled = [e.activity_task_scheduled_event_attributes
                     async for e in handle.fetch_history_events()
                     if e.event_type == EventType.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED]
        assert [(a.activity_type.name, a.task_queue.name) for a in scheduled] == [
            (f"{GRAPH_NAME}.supervisor_agent", TASK_QUEUE_LLM),
            (f"{GRAPH_NAME}.investment_agent", TASK_QUEUE_LLM),
            ("list_investments", TASK_QUEUE),
            (f"{GRAPH_NAME}.investment_agent", TASK_QUEUE_LLM),
        ]


@pytest.mark.parametrize(
    "shown_turns",
    [
        {},  # details never shown for this opening
        {"OpenAccount-test-123-Car-1": 2},  # only shown for an earlier opening
        {WORKFLOW_ID: 3},  # shown in the current turn; the customer hasn't replied yet
    ],
)
async def test_kyc_is_not_approved_until_the_customer_confirms(shown_turns):
    context = WealthManagementContext(turn=3, kyc_details_shown_turn=shown_turns)
    result = await approve_kyc.fn(context, workflow_id=WORKFLOW_ID)
    assert result.startswith("KYC was not approved")


CAR = "OpenAccount-test-123-Car-1"
VACATION = "OpenAccount-test-123-Vacation-2"
APPROVED: list = []


@activity.defn(name="get_current_client_info")
async def stub_get_current_client_info(workflow_id: str) -> dict:
    return {"client_id": "123", "first_name": "Sam", "last_name": "Doe", "address": "1 Main St",
            "phone": "555", "email": "s@example.com", "marital_status": "single"}


@activity.defn(name="approve_kyc")
async def stub_approve_kyc(workflow_id: str) -> None:
    APPROVED.append(workflow_id)


async def test_kyc_approved_only_after_the_customer_replies(temporal_env):
    client = temporal_env.client
    APPROVED.clear()
    events = EventStreamActivities(InMemoryEventStream())
    SCRIPT[:] = [
        # The model shows the details, then approves KYC in the same turn.
        handoff(INVEST_AGENT_NAME), handoff(OPEN_ACCOUNT_AGENT_NAME),
        tool("get_current_client_info", workflow_id=CAR), tool("approve_kyc", workflow_id=CAR),
        message("Are these details correct?"),
        tool("approve_kyc", workflow_id=CAR), message("KYC approved."),
        # The model treats the Car confirmation as approval for Vacation too.
        tool("get_current_client_info", workflow_id=VACATION), tool("approve_kyc", workflow_id=VACATION),
        message("Are these details still correct?"),
        tool("approve_kyc", workflow_id=VACATION), message("KYC approved."),
    ]

    async with workers(client, TASK_QUEUE, [stub_get_current_client_info, stub_approve_kyc,
                                            events.delete_conversation, events.append_chat_interaction]):
        handle = await client.start_workflow(WealthManagementWorkflow.run, id=f"kyc-guard-test-{uuid.uuid4()}",
                                             task_queue=TASK_QUEUE)
        reply = await send(handle, "Please open an account called Car.")
        assert "KYC was not approved" in reply.json_response and APPROVED == []
        reply = await send(handle, "Yes, that's correct.")
        assert "KYC approved" in reply.json_response and APPROVED == [CAR]
        reply = await send(handle, "Now open one called Vacation.")
        assert "KYC was not approved" in reply.json_response and APPROVED == [CAR]
        reply = await send(handle, "Yes, still correct.")
        assert "KYC approved" in reply.json_response and APPROVED == [CAR, VACATION]

        assert SCRIPT == []
        await handle.signal(WealthManagementWorkflow.end_workflow)
        await handle.result()
