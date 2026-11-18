"""Live test: asking to open the same account again starts a new account opening, with its own KYC.

The customer asks for their beneficiaries, gives client ID 123, asks for their investments,
opens "Vacation" with $13,000, confirms their details, then asks to open "Vacation" with
$13,000 again. The agent must start a second account opening (a second child workflow) and
show the client's details for KYC again, instead of answering from the conversation history.

The model decides whether to call the tool, so this can't be checked with the scripted model.
It runs the real ``WealthManagementWorkflow`` and ``OpenInvestmentAccountWorkflow`` with real
model calls, the real activities that only read data/*.json (beneficiaries, investments,
validation, client details) and the real open-account activities, which talk to the child
through the test server. update_client doesn't save, the event stream is kept in memory,
and the chaos flags read as off (so no promo code).

Not part of the default ``uv run pytest`` run, because it calls the paid model API. Run it
from the repository root with:

    source ./setllmkey.sh && uv run pytest tests/live_repeat_opening.py -s

LIVE_TEST_RUNS=<n> repeats the conversation n times (default 1), since model output varies.
Skipped when the key for LLM_MODEL is not set. Requires the Temporal test server
(downloaded automatically on first run). No Redis needed.
"""

import uuid

from temporalio import activity
from temporalio.service import RPCError
from temporalio.worker import Worker

from common.task_queues import TASK_QUEUE_OPEN_ACCOUNT
from temporal_supervisor.activities.beneficiaries import Beneficiaries
from temporal_supervisor.activities.clients import ClientActivities
from temporal_supervisor.activities.event_stream_activities import EventStreamActivities, InMemoryEventStream
from temporal_supervisor.activities.investments import Investments
from temporal_supervisor.activities.open_account import OpenAccount
from temporal_supervisor.workflows.open_account_workflow import OpenInvestmentAccountWorkflow
from temporal_supervisor.workflows.supervisor_workflow import WealthManagementWorkflow
from tests.live_support import RUNS, Conversation, chaos_off, live_model_worker, requires_model_key  # noqa: F401

pytestmark = requires_model_key

TASK_QUEUE = "repeat-opening-live-test"
OPEN_VACATION = "Open Vacation with $13,000"
# Client 123's details in data/clients.json
KYC_DETAILS = ["Don", "123 Main Street"]


@activity.defn(name="update_client")
async def unsaved_update_client(client_id: str, field_dict: dict) -> str:
    return "Client information successfully updated"


async def _started(client, workflow_id: str) -> bool:
    try:
        await client.get_workflow_handle(workflow_id).describe()
        return True
    except RPCError:
        return False


async def test_opening_the_same_account_again_starts_a_new_opening_with_kyc(temporal_env, chaos_off):
    client = temporal_env.client
    events = EventStreamActivities(InMemoryEventStream())
    open_account = OpenAccount(client)
    passed, failures = 0, []

    async with Worker(
        client,
        task_queue=TASK_QUEUE,
        workflows=[WealthManagementWorkflow],
        activities=[Beneficiaries.list_beneficiaries, Investments.list_investments,
                    Investments.validate_new_account, Investments.find_promotion,
                    open_account.get_current_client_info, open_account.approve_kyc,
                    open_account.update_client_details,
                    events.delete_conversation, events.append_chat_interaction, events.append_status_update],
    ), Worker(
        client,
        task_queue=TASK_QUEUE_OPEN_ACCOUNT,
        workflows=[OpenInvestmentAccountWorkflow],
        activities=[ClientActivities.get_client, unsaved_update_client],
    ), live_model_worker(client):
        for run in range(1, RUNS + 1):
            chat_id = f"repeat-opening-live-{run}-{uuid.uuid4()}"
            handle = await client.start_workflow(WealthManagementWorkflow.run, id=chat_id, task_queue=TASK_QUEUE)
            chat = Conversation(handle, run)
            try:
                await chat.say("Who are my beneficiaries?")
                await chat.say("123")
                await chat.say("What investments do I have?")
                first = await chat.say(OPEN_VACATION)
                for detail in KYC_DETAILS:
                    assert detail in first.text_response, f"first opening: KYC details not shown{chat.context()}"
                await chat.say("Yes")
                second = await chat.say(OPEN_VACATION)
                for detail in KYC_DETAILS:
                    assert detail in second.text_response, f"second opening: KYC details not shown{chat.context()}"
                for n in (1, 2):
                    child = f"OpenAccount-{chat_id}-123-Vacation-{n}"
                    assert await _started(client, child), f"{child} was not started{chat.context()}"
                passed += 1
            except AssertionError as e:
                failures.append(str(e))
            finally:
                await chat.end()

    print(f"\n{passed} of {RUNS} runs passed")
    assert not failures, f"{len(failures)} of {RUNS} runs failed:\n" + "\n\n".join(failures)
