"""The approve_kyc tool only approves KYC after the customer has seen and confirmed
their details for that account opening.

The first test calls the tool directly for the blocked cases: they return before
running any activity, so the tool can run outside a workflow. The second runs the real
``WealthManagementWorkflow`` with a scripted model that calls approve_kyc too early, and
stub activities (registered under the real activity names) that record which account
openings KYC was actually approved for.

Requires the Temporal test server (downloaded automatically on first run). No model
key or Redis needed.
"""

import uuid

import pytest
from temporalio import activity
from temporalio.worker import Worker

import tests.scripted_model as scripted_model
from common.agent_constants import INVEST_AGENT_NAME, OPEN_ACCOUNT_AGENT_NAME
from temporal_supervisor.activities.event_stream_activities import EventStreamActivities, InMemoryEventStream
from temporal_supervisor.workflows.supervisor_workflow import (
    WealthManagementContext,
    WealthManagementWorkflow,
    approve_kyc,
)
from tests.scripted_model import handoff, message, model_worker, send, tool

WORKFLOW_ID = "OpenAccount-test-123-Education-2"


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


TASK_QUEUE = "test-kyc-guard"
CAR = "OpenAccount-test-123-Car-1"
VACATION = "OpenAccount-test-123-Vacation-2"

# Account openings that KYC was approved for, in order, recorded worker-side.
APPROVED: list = []


@activity.defn(name="get_current_client_info")
async def stub_get_current_client_info(workflow_id: str) -> dict:
    return {
        "client_id": "123", "first_name": "Sam", "last_name": "Doe", "address": "1 Main St",
        "phone": "555", "email": "s@example.com", "marital_status": "single",
    }


@activity.defn(name="approve_kyc")
async def stub_approve_kyc(workflow_id: str) -> None:
    APPROVED.append(workflow_id)


async def test_kyc_approved_only_after_the_customer_replies(temporal_env):
    client = temporal_env.client
    APPROVED.clear()
    events = EventStreamActivities(InMemoryEventStream())
    scripted_model.SCRIPT[:] = [
        # Customer asks to open Car. The model shows their details, then approves
        # KYC in the same turn without waiting for the customer to answer.
        handoff(INVEST_AGENT_NAME),
        handoff(OPEN_ACCOUNT_AGENT_NAME),
        tool("get_current_client_info", workflow_id=CAR),
        tool("approve_kyc", workflow_id=CAR),
        message("Are these details correct?"),
        # Customer confirms.
        tool("approve_kyc", workflow_id=CAR),
        message("KYC approved."),
        # Customer asks to open Vacation. The model treats the Car confirmation as
        # approval for this opening too.
        tool("get_current_client_info", workflow_id=VACATION),
        tool("approve_kyc", workflow_id=VACATION),
        message("Are these details still correct?"),
        # Customer confirms.
        tool("approve_kyc", workflow_id=VACATION),
        message("KYC approved."),
    ]

    async with Worker(
        client,
        task_queue=TASK_QUEUE,
        workflows=[WealthManagementWorkflow],
        activities=[stub_get_current_client_info, stub_approve_kyc,
                    events.delete_conversation, events.append_chat_interaction],
    ), model_worker(client):
        handle = await client.start_workflow(
            WealthManagementWorkflow.run, id=f"kyc-guard-test-{uuid.uuid4()}", task_queue=TASK_QUEUE
        )

        reply = await send(handle, "Please open an account called Car.")
        assert "KYC was not approved" in reply.json_response
        assert APPROVED == []

        reply = await send(handle, "Yes, that's correct.")
        assert "KYC approved" in reply.json_response
        assert APPROVED == [CAR]

        reply = await send(handle, "Now open one called Vacation.")
        assert "KYC was not approved" in reply.json_response
        assert APPROVED == [CAR]

        reply = await send(handle, "Yes, still correct.")
        assert "KYC approved" in reply.json_response
        assert APPROVED == [CAR, VACATION]

        assert scripted_model.SCRIPT == []
        await handle.signal(WealthManagementWorkflow.end_workflow)
        await handle.result()
