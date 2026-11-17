"""The shared API's Temporal calls work against this port's real chat workflow.

The API (src/python/api) connects without this port's StrandsPlugin or workflow class:
it uses the contract names and the Pydantic data converter. This test makes the API's
exact calls, from ``api.client``, to the real ``WealthManagementWorkflow``, run with
the scripted model from test_durable_hitl: start the chat, send a message that asks to
delete a beneficiary, read the pending approval, approve it, and end the chat. The
delete must run once, after the approval.

Requires the Temporal test server (downloaded automatically on first run). No
GEMINI_API_KEY or Redis needed.
"""

import asyncio
import uuid

from temporalio.contrib.strands import StrandsPlugin
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

import tests.test_durable_hitl as hitl
from api import client as api_client
from durable.model_config import LLM_TASK_QUEUE
from durable.workflows.supervisor_workflow import WealthManagementWorkflow

TASK_QUEUE = "test-api-client"


async def test_the_api_client_starts_messages_approves_and_ends_the_real_chat_workflow(monkeypatch):
    monkeypatch.delenv("USE_CLAIM_CHECK", raising=False)
    hitl.DELETE_CALLS.clear()
    workflow_id = f"strands-temporal-agent-{uuid.uuid4().hex[:12]}"

    async with await WorkflowEnvironment.start_local(plugins=[StrandsPlugin(models=hitl.MODELS)]) as env:
        api = await api_client.connect(
            target_host=env.client.service_client.config.target_host,
            namespace=env.client.namespace,
        )
        async with Worker(
            env.client,
            task_queue=TASK_QUEUE,
            workflows=[WealthManagementWorkflow],
            activities=hitl.STUB_ACTIVITIES,
        ), Worker(env.client, task_queue=LLM_TASK_QUEUE):
            await api_client.start_chat(api, workflow_id, TASK_QUEUE)
            await api_client.send_prompt(
                api, workflow_id, f"Please delete beneficiary {hitl.BENE_ID} for client {hitl.CLIENT_ID}")

            question = None
            for _ in range(160):
                if question := await api_client.pending_approval(api, workflow_id):
                    break
                await asyncio.sleep(0.25)
            assert question == "Are you sure you want to run delete_beneficiary?"
            assert hitl.DELETE_CALLS == []  # nothing is deleted before the approval

            await api_client.answer_approval(api, workflow_id, "approve")

            handle = env.client.get_workflow_handle(workflow_id)
            for _ in range(160):
                if await handle.query(WealthManagementWorkflow.get_chat_history):
                    break
                await asyncio.sleep(0.25)
            assert hitl.DELETE_CALLS == [(hitl.CLIENT_ID, hitl.BENE_ID)]
            assert await api_client.pending_approval(api, workflow_id) is None

            await api_client.end_chat(api, workflow_id)
            await asyncio.wait_for(handle.result(), timeout=10)


def test_the_api_knows_this_ports_task_queue():
    """./startlocalapi.sh strands_agents starts chats where this port's worker listens by default."""
    from api.ports import PORTS
    from durable.model_config import DEFAULT_TASK_QUEUE

    assert PORTS["strands_agents"].task_queue == DEFAULT_TASK_QUEUE
    assert PORTS["strands_agents"].approvals
