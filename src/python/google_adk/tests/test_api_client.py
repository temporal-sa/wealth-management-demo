"""The shared API's Temporal calls work against this port's real chat workflow.

The API (src/python/api) connects without this port's GoogleAdkPlugin or workflow class:
it uses the contract names and Temporal's Pydantic data converter. The plugin's converter
is Pydantic JSON too, so both sides read each other's payloads. This test makes the API's
exact calls, from ``api.client``, to the real ``WealthManagementWorkflow`` run with the
scripted model (see chat_harness.py), and checks the workflow decodes the message,
answers it, and ends.

Requires the Temporal test server (downloaded automatically on first run). No
GEMINI_API_KEY or Redis needed.
"""

import asyncio
import uuid

import pytest
from temporalio.testing import WorkflowEnvironment

import tests.scripted_model as model
from api import client as api_client
from tests.chat_harness import TASK_QUEUE, chat_workers, published_turns
from tests.scripted_model import text

REPLY = "Happy to help. What is your client ID?"

pytestmark = pytest.mark.usefixtures("scripted")


async def test_the_api_client_starts_messages_and_ends_the_real_chat_workflow(monkeypatch):
    monkeypatch.delenv("USE_CLAIM_CHECK", raising=False)
    workflow_id = f"adk-temporal-agent-{uuid.uuid4().hex[:12]}"

    async with await WorkflowEnvironment.start_local() as env:
        api = await api_client.connect(
            target_host=env.client.service_client.config.target_host,
            namespace=env.client.namespace,
        )
        async with chat_workers(env.client) as client:
            model.expect("Supervisor_Agent", text(REPLY))
            await api_client.start_chat(api, workflow_id, TASK_QUEUE)
            await api_client.send_prompt(api, workflow_id, "Who are my beneficiaries?")

            for _ in range(100):
                if published_turns.get(workflow_id):
                    break
                await asyncio.sleep(0.1)
            assert [(t.user_prompt, t.text_response) for t in published_turns[workflow_id]] == [
                ("Who are my beneficiaries?", REPLY)
            ]
            assert "user: Who are my beneficiaries?" in model.calls[-1].contents

            await api_client.end_chat(api, workflow_id)
            await asyncio.wait_for(client.get_workflow_handle(workflow_id).result(), timeout=10)


def test_the_api_knows_this_ports_task_queue():
    """./startlocalapi.sh google_adk starts chats where this port's worker listens by default."""
    from api.ports import PORTS
    from durable.task_queues import DEFAULT_TASK_QUEUE

    assert PORTS["google_adk"].task_queue == DEFAULT_TASK_QUEUE
