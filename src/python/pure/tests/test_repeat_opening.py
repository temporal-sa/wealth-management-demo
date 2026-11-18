"""Every request to open an account starts a new account opening, with its own KYC.

The customer opens "Vacation" twice in one conversation. The real ``WealthManagementWorkflow``
runs with a scripted model and the real ``open_new_investment_account`` tool, which starts
the real ``OpenInvestmentAccountWorkflow`` as a child. The chat-side open-account
activities (get_current_client_info, approve_kyc) are the real ones, talking to the child
through the test server; the business activities are stubs registered under the real
activity names, and the event stream is kept in memory, so no Redis, data files or
running Temporal service are touched.

Checks that each opening gets its own child workflow (``...-Vacation-1``, ``...-Vacation-2``),
both run, an opening refused by validation doesn't use up a number, the second opening's
KYC is not approved by the first opening's confirmation, and the child's state changes
reach the chat's event stream.

Requires the Temporal test server (downloaded automatically on first run). No model
key or Redis needed.
"""

import asyncio
import uuid

from temporalio import activity
from temporalio.client import WorkflowExecutionStatus
from temporalio.exceptions import ApplicationError
from temporalio.worker import Worker

import tests.scripted_model as scripted_model
from common.agent_constants import INVEST_AGENT_NAME, OPEN_ACCOUNT_AGENT_NAME
from common.task_queues import TASK_QUEUE_OPEN_ACCOUNT
from temporal_supervisor.activities.event_stream_activities import EventStreamActivities, InMemoryEventStream
from temporal_supervisor.activities.open_account import OpenAccount
from temporal_supervisor.workflows.open_account_workflow import OpenInvestmentAccountWorkflow
from temporal_supervisor.workflows.supervisor_workflow import WealthManagementWorkflow
from tests.scripted_model import handoff, message, model_worker, send, tool

TASK_QUEUE = "test-repeat-opening"
CLIENT_ID = "123"


@activity.defn(name="validate_new_account")
async def stub_validate_new_account(client_id: str, account_name: str, initial_amount: float) -> None:
    if initial_amount < 100:
        raise ApplicationError("The initial deposit must be at least $100.", type="DepositBelowMinimum",
                               non_retryable=True)


@activity.defn(name="find_promotion")
async def stub_find_promotion(client_id: str) -> None:
    return None


@activity.defn(name="get_client")
async def stub_get_client(client_id: str) -> dict:
    return {
        "client_id": client_id, "first_name": "Don", "last_name": "Doe", "address": "123 Main Street",
        "phone": "555", "email": "don@example.com", "marital_status": "single",
    }


async def _state(client, workflow_id: str, expected: str) -> str:
    handle = client.get_workflow_handle(workflow_id)
    state = None
    for _ in range(40):
        state = await handle.query(OpenInvestmentAccountWorkflow.get_current_state)
        if state == expected:
            break
        await asyncio.sleep(0.25)
    return state


async def test_opening_the_same_account_twice_starts_two_openings_with_their_own_kyc(temporal_env):
    client = temporal_env.client
    stream = InMemoryEventStream()
    events = EventStreamActivities(stream)
    open_account = OpenAccount(client)
    chat_id = f"repeat-opening-test-{uuid.uuid4()}"
    first = f"OpenAccount-{chat_id}-{CLIENT_ID}-Vacation-1"
    second = f"OpenAccount-{chat_id}-{CLIENT_ID}-Vacation-2"
    open_vacation = dict(client_id=CLIENT_ID, account_name="Vacation", initial_amount=13000.0)
    scripted_model.SCRIPT[:] = [
        # An opening refused by validation doesn't start a child or use up a number.
        handoff(INVEST_AGENT_NAME),
        handoff(OPEN_ACCOUNT_AGENT_NAME),
        tool("open_new_investment_account", client_id=CLIENT_ID, account_name="Vacation", initial_amount=50.0),
        message("The initial deposit must be at least $100."),
        # First opening. The status is known from the start.
        tool("open_new_investment_account", **open_vacation),
        tool("get_account_opening_status", workflow_id=first),
        tool("get_current_client_info", workflow_id=first),
        message("Are these details correct?"),
        # Customer confirms.
        tool("approve_kyc", workflow_id=first),
        message("KYC approved. Waiting for compliance review."),
        # Second opening of the same account name. The model treats the first
        # opening's confirmation as approval for this one too.
        tool("open_new_investment_account", **open_vacation),
        tool("approve_kyc", workflow_id=second),
        tool("get_current_client_info", workflow_id=second),
        message("Are these details still correct?"),
        # Customer confirms.
        tool("approve_kyc", workflow_id=second),
        message("KYC approved. Waiting for compliance review."),
    ]

    async with Worker(
        client,
        task_queue=TASK_QUEUE,
        workflows=[WealthManagementWorkflow],
        activities=[stub_validate_new_account, stub_find_promotion,
                    open_account.get_current_client_info, open_account.approve_kyc,
                    events.delete_conversation, events.append_chat_interaction, events.append_status_update],
    ), Worker(
        client,
        task_queue=TASK_QUEUE_OPEN_ACCOUNT,
        workflows=[OpenInvestmentAccountWorkflow],
        activities=[stub_get_client],
    ), model_worker(client):
        handle = await client.start_workflow(WealthManagementWorkflow.run, id=chat_id, task_queue=TASK_QUEUE)

        reply = await send(handle, "Open Vacation with $50")
        assert "cannot be opened" in reply.json_response

        reply = await send(handle, "Open Vacation with $13,000")
        assert first in reply.json_response
        assert reply.json_response.splitlines()[1] in ("Initializing", "Waiting KYC")
        assert "123 Main Street" in reply.json_response
        assert await _state(client, first, "Waiting KYC") == "Waiting KYC"

        reply = await send(handle, "Yes")
        assert "KYC approved" in reply.json_response
        assert await _state(client, first, "Waiting Compliance Review") == "Waiting Compliance Review"

        reply = await send(handle, "Open Vacation with $13,000")
        assert second in reply.json_response
        assert "KYC was not approved" in reply.json_response
        assert "123 Main Street" in reply.json_response
        assert await _state(client, second, "Waiting KYC") == "Waiting KYC"
        assert await _state(client, first, "Waiting Compliance Review") == "Waiting Compliance Review"

        reply = await send(handle, "Yes")
        assert "KYC approved" in reply.json_response
        assert await _state(client, second, "Waiting Compliance Review") == "Waiting Compliance Review"

        # Both openings are separate child workflows of this chat, still running.
        for child in (first, second):
            description = await client.get_workflow_handle(child).describe()
            assert description.status == WorkflowExecutionStatus.RUNNING
            assert description.parent_id == chat_id

        assert scripted_model.SCRIPT == []

        # The children's state changes reach the event stream the UI polls.
        statuses = []
        for _ in range(40):
            statuses = [e["content"].status for e in stream.events[chat_id] if e["type"] == "status_update"]
            if "New Vacation account status changed: Waiting Compliance Review" in statuses[-1:]:
                break
            await asyncio.sleep(0.25)
        assert statuses.count("New Vacation account status changed: Waiting KYC") == 2
        assert statuses.count("New Vacation account status changed: Waiting Compliance Review") == 2

        await handle.signal(WealthManagementWorkflow.end_workflow)
        await handle.result()

    # The chat closed, and the server applies its parent close policy: both openings are terminated.
    for child in (first, second):
        status = None
        for _ in range(40):
            status = (await client.get_workflow_handle(child).describe()).status
            if status == WorkflowExecutionStatus.TERMINATED:
                break
            await asyncio.sleep(0.25)
        assert status == WorkflowExecutionStatus.TERMINATED
