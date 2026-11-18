"""Live test: after two openings of the same account name, the agents report each one correctly.

The customer opens "Vacation" with $13,500, confirms their details, lists their investments,
opens "Vacation" with $13,500 again and confirms again. Then the first opening is rolled back
(the custodian rejected it) and the second completes, so one Vacation account exists. When
the customer lists their investments, the reply must not claim that an opening is still
pending or that a duplicate account may appear, which a model that isn't told the openings'
states tends to do.

Runs the real ``WealthManagementWorkflow`` with real model calls and the real activities that
only read data/*.json. The open-account activities are stubs and the openings' states are
sent as the update_account_opening_state signals the child workflows would send, so no
account is created and no data file changes. The event stream is kept in memory and the chaos
flags read as off, so no Redis is needed.

Not part of the default ``uv run pytest`` run, because it calls the paid model API. Run it
from the repository root with:

    source ./setllmkey.sh && uv run pytest tests/live_opening_status.py -s

LIVE_TEST_RUNS=<n> repeats the conversation n times (default 1), since model output varies.
"""

import uuid

from temporalio import activity
from temporalio.service import RPCError
from temporalio.worker import Worker

from common.account_context import UpdateAccountOpeningStateInput
from temporal_supervisor.activities.beneficiaries import Beneficiaries
from temporal_supervisor.activities.event_stream_activities import EventStreamActivities, InMemoryEventStream
from temporal_supervisor.activities.investments import Investments
from temporal_supervisor.workflows.supervisor_workflow import WealthManagementWorkflow
from tests.live_support import RUNS, Conversation, chaos_off, live_model_worker, requires_model_key  # noqa: F401

pytestmark = requires_model_key

TASK_QUEUE = "opening-status-live-test"
OPEN_VACATION = "Open Vacation with $13,500"
ROLLED_BACK = "Rolled back. The account was not opened: The custodian rejected the account registration."
# Words of a reply that thinks an opening is still pending, or a duplicate may appear.
WRONG = ["duplicate", "still waiting", "pending", "still processing", "compliance review"]

# Set by the test before the final turn: one Vacation account, from the second opening.
INVESTMENTS: list = []


@activity.defn(name="list_investments")
async def stub_list_investments(client_id: str) -> list:
    return INVESTMENTS


@activity.defn(name="get_current_client_info")
async def stub_get_current_client_info(workflow_id: str) -> dict:
    return {"client_id": "123", "first_name": "Don", "last_name": "Doe", "address": "123 Main Street",
            "phone": "999-555-1212", "email": "jd@someplace.com", "marital_status": "married"}


@activity.defn(name="approve_kyc")
async def stub_approve_kyc(workflow_id: str) -> None:
    pass


async def _started(client, workflow_id: str) -> bool:
    try:
        await client.get_workflow_handle(workflow_id).describe()
        return True
    except RPCError:
        return False


BASE_INVESTMENTS = [
    {"investment_id": "i-8f494d01", "name": "Checking", "balance": 1000.0},
    {"investment_id": "i-1872ae24", "name": "Savings", "balance": 2312.08},
    {"investment_id": "i-8846d0b8", "name": "401K", "balance": 11070.89},
]


async def test_agents_report_each_opening_from_its_state(temporal_env, chaos_off):
    client = temporal_env.client
    events = EventStreamActivities(InMemoryEventStream())
    passed, failures = 0, []

    async with Worker(
        client,
        task_queue=TASK_QUEUE,
        workflows=[WealthManagementWorkflow],
        activities=[Beneficiaries.list_beneficiaries, stub_list_investments,
                    Investments.validate_new_account, Investments.find_promotion,
                    stub_get_current_client_info, stub_approve_kyc,
                    events.delete_conversation, events.append_chat_interaction, events.append_status_update],
    ), live_model_worker(client):
        for run in range(1, RUNS + 1):
            INVESTMENTS[:] = BASE_INVESTMENTS
            chat_id = f"opening-status-live-{run}-{uuid.uuid4()}"
            handle = await client.start_workflow(WealthManagementWorkflow.run, id=chat_id, task_queue=TASK_QUEUE)
            chat = Conversation(handle, run)

            async def report(n: int, state: str):
                await handle.signal(WealthManagementWorkflow.update_account_opening_state,
                                    UpdateAccountOpeningStateInput(account_name="Vacation", state=state,
                                                                   workflow_id=f"OpenAccount-{chat_id}-123-Vacation-{n}"))

            try:
                await chat.say("Who are my beneficiaries?")
                await chat.say("123")
                await chat.say("What investments do I have?")
                await chat.say(OPEN_VACATION)
                await report(1, "Waiting KYC")
                await chat.say("Yes")
                await report(1, "Waiting Compliance Review")
                await chat.say("list investments")
                await chat.say(OPEN_VACATION)
                await report(2, "Waiting KYC")
                await chat.say("Yes")
                await report(2, "Waiting Compliance Review")
                for n in (1, 2):
                    child = f"OpenAccount-{chat_id}-123-Vacation-{n}"
                    assert await _started(client, child), f"{child} was not started{chat.context()}"

                await report(1, ROLLED_BACK)
                await report(2, "Complete")
                INVESTMENTS[:] = BASE_INVESTMENTS + [
                    {"investment_id": "i-fcc983e4", "name": "Vacation", "balance": 13500.0}]
                final = await chat.say("list investments")

                reply = final.text_response.lower()
                assert "vacation" in reply, f"Vacation account not listed{chat.context()}"
                wrong = [w for w in WRONG if w in reply]
                assert not wrong, f"reply treats an opening as pending ({', '.join(wrong)}){chat.context()}"
                passed += 1
            except AssertionError as e:
                failures.append(str(e))
            finally:
                await chat.end()

    print(f"\n{passed} of {RUNS} runs passed")
    assert not failures, f"{len(failures)} of {RUNS} runs failed:\n" + "\n\n".join(failures)
