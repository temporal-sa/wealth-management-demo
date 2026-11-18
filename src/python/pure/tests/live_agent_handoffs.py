"""Live test of the agent handoffs, against the real model.

A customer asks the Beneficiary Agent about their beneficiaries, gives client ID 123,
then asks about their investments. In that same turn the Beneficiary Agent should hand
the conversation back to the supervisor, which hands it to the Investment Agent, which
lists the accounts without asking for the client ID again. No agent may announce the
transfer.

The model decides whether to hand off, so this can't be checked with the scripted model.
It runs the real ``WealthManagementWorkflow`` with real model calls (the invoke_model
activity, through LiteLLM) and the real beneficiary and investment activities, which only
read data/*.json. The event stream is kept in memory and the chaos flags read as off.

Not part of the default ``uv run pytest`` run (the file name doesn't match ``test_*.py``),
because it calls the paid model API. Run it from the repository root with:

    source ./setllmkey.sh && uv run pytest tests/live_agent_handoffs.py -s

LIVE_TEST_RUNS=<n> repeats the conversation n times (default 1), since model output varies.
Skipped when the key for LLM_MODEL is not set. Requires the Temporal test server
(downloaded automatically on first run). No Redis needed.
"""

import re
import uuid

from temporalio.worker import Worker

from common.agent_constants import BENE_AGENT_NAME, INVEST_AGENT_NAME, SUPERVISOR_AGENT_NAME
from temporal_supervisor.activities.beneficiaries import Beneficiaries
from temporal_supervisor.activities.event_stream_activities import EventStreamActivities, InMemoryEventStream
from temporal_supervisor.activities.investments import Investments
from temporal_supervisor.workflows.supervisor_workflow import WealthManagementWorkflow
from tests.live_support import (AGENT_MESSAGES, RUNS, Conversation, chaos_off,  # noqa: F401
                                live_model_worker, requires_model_key)

pytestmark = requires_model_key

TASK_QUEUE = "agent-handoffs-live-test"
# Client 123's accounts in data/investments.json and beneficiaries in data/beneficiaries.json
CLIENT_123_ACCOUNTS = ["Checking", "Savings", "401K"]
CLIENT_123_BENEFICIARIES = ["John", "Jane", "Joan"]
TRANSFER = re.compile(r"transfer", re.IGNORECASE)


async def test_investment_question_asked_while_talking_to_the_beneficiary_agent(temporal_env, chaos_off):
    client = temporal_env.client
    events = EventStreamActivities(InMemoryEventStream())
    passed, failures = 0, []

    async with Worker(
        client,
        task_queue=TASK_QUEUE,
        workflows=[WealthManagementWorkflow],
        activities=[Beneficiaries.list_beneficiaries, Investments.list_investments,
                    events.delete_conversation, events.append_chat_interaction, events.append_status_update],
    ), live_model_worker(client):
        for run in range(1, RUNS + 1):
            handle = await client.start_workflow(WealthManagementWorkflow.run,
                                                 id=f"agent-handoffs-live-{run}-{uuid.uuid4()}",
                                                 task_queue=TASK_QUEUE)
            chat = Conversation(handle, run)
            try:
                await chat.say("Who are my beneficiaries?")
                beneficiaries = await chat.say("123")
                for name in CLIENT_123_BENEFICIARIES:
                    assert name in beneficiaries.text_response, f"beneficiary {name} not listed{chat.context()}"

                investments = await chat.say("What investments do I have?")
                trace = investments.agent_trace or ""
                for account in CLIENT_123_ACCOUNTS:
                    assert account in investments.text_response, f"account {account} not listed{chat.context()}"
                assert f"Handed off from {BENE_AGENT_NAME} to {SUPERVISOR_AGENT_NAME}" in trace, \
                    f"the Beneficiary Agent did not hand off to the supervisor{chat.context()}"
                assert f"Handed off from {SUPERVISOR_AGENT_NAME} to {INVEST_AGENT_NAME}" in trace, \
                    f"the supervisor did not hand off to the Investment Agent{chat.context()}"
                assert f"{INVEST_AGENT_NAME}: Calling a tool" in trace, \
                    f"the Investment Agent did not call list_investments{chat.context()}"
                assert not re.search(r"client id", investments.text_response, re.IGNORECASE), \
                    f"asked for the client ID again{chat.context()}"
                said = [s for _, s in AGENT_MESSAGES if not s.startswith("<calls")]
                assert not any(TRANSFER.search(s) for s in said), f"an agent talked about a transfer{chat.context()}"
                passed += 1
            except AssertionError as e:
                failures.append(str(e))
            finally:
                await chat.end()

    print(f"\n{passed} of {RUNS} runs passed")
    assert not failures, f"{len(failures)} of {RUNS} runs failed:\n" + "\n\n".join(failures)
