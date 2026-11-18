"""The shared API's Temporal calls work against this port's real chat workflow.

The API (src/python/api) connects without this port's StrandsPlugin or workflow class:
it uses the contract names and the Pydantic data converter. This test makes the API's
exact calls, from ``api.client``, to the real ``WealthManagementWorkflow``, run with
the scripted model from test_chat_confirmation: start the chat, ask to delete a
beneficiary, confirm it in the next message, and end the chat. Like the other ports,
the confirmation goes through the chat, so the API needs nothing else. The delete
must run once, after the confirmation.

Requires the Temporal test server (downloaded automatically on first run). No
GEMINI_API_KEY or Redis needed.
"""

import asyncio
import uuid

from temporalio.contrib.strands import StrandsPlugin
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

import tests.test_chat_confirmation as chat
from api import client as api_client
from durable.model_config import LLM_TASK_QUEUE
from durable.workflows.supervisor_workflow import WealthManagementWorkflow

TASK_QUEUE = "test-api-client"


async def test_the_api_client_starts_messages_and_ends_the_real_chat_workflow(monkeypatch):
    monkeypatch.delenv("USE_CLAIM_CHECK", raising=False)
    chat.DELETE_CALLS.clear()
    workflow_id = f"strands-temporal-agent-{uuid.uuid4().hex[:12]}"

    async with await WorkflowEnvironment.start_local(plugins=[StrandsPlugin(models=chat.MODELS)]) as env:
        api = await api_client.connect(
            target_host=env.client.service_client.config.target_host,
            namespace=env.client.namespace,
        )
        async with Worker(
            env.client,
            task_queue=TASK_QUEUE,
            workflows=[WealthManagementWorkflow],
            activities=chat.STUB_ACTIVITIES,
        ), Worker(env.client, task_queue=LLM_TASK_QUEUE):
            await api_client.start_chat(api, workflow_id, TASK_QUEUE)
            handle = env.client.get_workflow_handle(workflow_id)

            await api_client.send_prompt(api, workflow_id, chat.DELETE_REQUEST)
            assert "has not confirmed" in await chat.wait_for_reply(handle, 1)
            assert chat.DELETE_CALLS == []  # nothing is deleted before the confirmation

            await api_client.send_prompt(api, workflow_id, "Yes")
            await chat.wait_for_reply(handle, 2)
            assert chat.DELETE_CALLS == [(chat.CLIENT_ID, chat.BENE_ID)]

            await api_client.end_chat(api, workflow_id)
            await asyncio.wait_for(handle.result(), timeout=10)


def test_the_api_knows_this_ports_task_queue():
    """./startlocalapi.sh strands_agents starts chats where this port's worker listens by default."""
    from api.ports import PORTS
    from durable.model_config import DEFAULT_TASK_QUEUE

    assert PORTS["strands_agents"].task_queue == DEFAULT_TASK_QUEUE
