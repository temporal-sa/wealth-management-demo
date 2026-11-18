"""Live test of confirming a delete or close in the chat, against the real Gemini model.

Like the other ports, the agent asks the customer to confirm deleting a beneficiary or
closing an investment account, and the customer's next message answers. Each
conversation asks for one, then answers "Yes" or "No":

  - nothing is deleted or closed before the answer, and the reply asks to confirm,
    naming the beneficiary or account
  - "Yes" deletes or closes exactly that one, once, without asking again
  - "No" deletes or closes nothing

Whether the agent asks well and acts on the answer depends on the model and the
prompts, so this can't be checked with a scripted model (test_chat_confirmation.py
checks the guard itself). It runs the real ``WealthManagementWorkflow`` with real
Gemini calls and the real list activities (which only read data/*.json). The delete
and close activities only record what they were asked to do, so the data files are
never changed; the Redis-backed event stream activities are replaced with
in-memory stand-ins.

Not part of the default ``uv run pytest`` run, because it calls the paid Gemini API
(pytest only collects test_*.py files). Run it with:

    source ../../../scripts/setgeminikey.sh && uv run pytest tests/live_confirmations.py -s

LIVE_TEST_RUNS=<n> repeats each conversation n times (default 1), since model output
varies. Skipped when GEMINI_API_KEY is not set. Requires the Temporal test server
(downloaded automatically on first run); no Redis needed.
"""

import os
import re
import uuid

import pytest
from temporalio import activity
from temporalio.contrib.strands import StrandsPlugin
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from common.beneficiaries_manager import BeneficiariesManager
from common.investment_manager import InvestmentManager
from durable.activities.beneficiaries import Beneficiaries
from durable.activities.investments import Investments
from durable.model_config import LLM_TASK_QUEUE, MODEL_NAME
from durable.workflows.supervisor_workflow import WealthManagementWorkflow
from tests.live_agent_handoffs import (
    RUNS,
    _send,
    _trace,
    chaos_off,  # noqa: F401 (autouse fixture)
    recording_gemini_factory,
    stub_append_chat_interaction,
    stub_append_status_update,
    stub_delete_conversation,
)

pytestmark = pytest.mark.skipif(
    not (os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")),
    reason="GEMINI_API_KEY is not set; run `source ../../../scripts/setgeminikey.sh` first",
)

TASK_QUEUE = "confirmations-live-test"
# Client 123 in data/beneficiaries.json and data/investments.json
JANE = "b-3bc09dd2"
SAVINGS = "i-1872ae24"

# What the delete and close activities were asked to do, in order.
CHANGES: list = []


@activity.defn(name="delete_beneficiary")
async def record_delete_beneficiary(client_id: str, beneficiary_id: str) -> str:
    CHANGES.append(("delete_beneficiary", client_id, beneficiary_id))
    # What the real activity returns, without changing data/beneficiaries.json
    name = BeneficiariesManager().display_name(client_id, beneficiary_id)
    return f"{name} deleted successfully." if name else f"Beneficiary {beneficiary_id} deleted successfully."


@activity.defn(name="close_investment")
async def record_close_investment(client_id: str, investment_id: str) -> str:
    CHANGES.append(("close_investment", client_id, investment_id))
    # What the real activity returns, without changing data/investments.json
    name = InvestmentManager().account_name(client_id, investment_id)
    return f"{name} closed successfully." if name else f"Investment account {investment_id} closed successfully."


ACTIVITIES = [
    Beneficiaries.list_beneficiaries,
    Beneficiaries.add_beneficiary,
    record_delete_beneficiary,
    Investments.list_investments,
    record_close_investment,
    stub_append_chat_interaction,
    stub_append_status_update,
    stub_delete_conversation,
]

# (request, the name the confirmation question should mention, the answer, the changes expected after it)
CONVERSATIONS = [
    ("My client ID is 123. Please delete my beneficiary Jane Doe.", "Jane", "Yes",
     [("delete_beneficiary", "123", JANE)]),
    ("My client ID is 123. Please delete my beneficiary Jane Doe.", "Jane", "No", []),
    ("My client ID is 123. Please close my Savings account.", "Savings", "Yes, please close it",
     [("close_investment", "123", SAVINGS)]),
    ("My client ID is 123. Please close my Savings account.", "Savings", "No, keep it", []),
]


@pytest.fixture(scope="module")
async def temporal_env():
    plugin = StrandsPlugin(models={MODEL_NAME: recording_gemini_factory})
    async with await WorkflowEnvironment.start_local(plugins=[plugin]) as env:
        yield env


async def _run_conversation(env: WorkflowEnvironment, request: str, name: str, answer: str,
                            expected: list, run: int) -> dict:
    """Ask, then answer. Returns the result; never raises on a failed check."""
    CHANGES.clear()
    transcript: list = []
    failures: list = []
    handle = await env.client.start_workflow(
        WealthManagementWorkflow.run,
        id=f"confirmations-live-{run}-{uuid.uuid4()}",
        task_queue=TASK_QUEUE,
    )

    async def say(text: str) -> str:
        reply, calls = await _send(handle, text)
        transcript.extend([f"Customer: {text}", f"Agent: {reply}", "  trace:", _trace(calls)])
        return reply

    try:
        question = await say(request)
        if CHANGES:
            failures.append(f"changed before the customer answered: {CHANGES}")
        if "?" not in question or not re.search(rf"\b{re.escape(name)}\b", question, re.I):
            failures.append(f"the reply doesn't ask to confirm, naming {name}")

        reply = await say(answer)
        if CHANGES != expected:
            failures.append(f"after {answer!r}: changes {CHANGES}, expected {expected}")
        if expected and re.search(r"are you sure|confirm", reply, re.I):
            failures.append("asked to confirm again after the customer said yes")
        if re.search(r"\b[bi]-[0-9a-f]{8}\b", question + reply):
            failures.append("showed a beneficiary or investment ID")
    finally:
        await handle.signal(WealthManagementWorkflow.end_workflow)
        await handle.result()

    text = f"\n{request!r} -> {answer!r}, run {run} of {RUNS}:\n" + "\n".join(transcript)
    print(text)
    return {"failures": failures, "transcript": text}


async def test_deletes_and_closes_are_confirmed_in_the_chat(temporal_env):
    results = []
    async with Worker(
        temporal_env.client,
        task_queue=TASK_QUEUE,
        workflows=[WealthManagementWorkflow],
        activities=ACTIVITIES,
    ), Worker(temporal_env.client, task_queue=LLM_TASK_QUEUE):  # the model calls run here
        for run in range(1, RUNS + 1):
            for request, name, answer, expected in CONVERSATIONS:
                results.append(await _run_conversation(temporal_env, request, name, answer, expected, run))

    failed = [r for r in results if r["failures"]]
    print(f"\nLive confirmations: {len(results) - len(failed)}/{len(results)} conversations passed")
    assert not failed, "\n".join(f"Failed: {'; '.join(r['failures'])}{r['transcript']}" for r in failed)
