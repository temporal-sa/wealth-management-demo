"""The shared API's Temporal calls work against this port's real chat workflow.

The API (src/python/api) connects without this port's plugin or workflow class: it
uses the contract names and the Pydantic data converter. This test makes the API's
exact calls, from ``api.client``, to the real ``WealthManagementWorkflow`` run with a
scripted model, and checks the workflow decodes the message and answers it.

Requires the Temporal test server (downloaded automatically on first run). No
OPENAI_API_KEY or Redis needed.
"""

import asyncio
import uuid
from typing import Any

import pytest
from temporalio import activity
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

import tests.scripted_model as scripted_model
from api import client as api_client
from durable.workflows.supervisor_workflow import WealthManagementWorkflow
from tests.scripted_model import message, scripted_client

TASK_QUEUE = "test-api-client"


@activity.defn(name="delete_conversation")
async def stub_delete_conversation(workflow_id: str) -> bool:
    return True


@activity.defn(name="append_chat_interaction")
async def stub_append_chat_interaction(workflow_id: str, chat_interaction: Any) -> int:
    return 0


@pytest.fixture(scope="module")
async def temporal_env():
    async with await WorkflowEnvironment.start_local() as env:
        yield env


async def test_the_api_client_starts_messages_and_ends_the_real_chat_workflow(temporal_env, monkeypatch):
    monkeypatch.delenv("USE_CLAIM_CHECK", raising=False)
    worker_client = scripted_client(temporal_env.client)
    api = await api_client.connect(
        target_host=temporal_env.client.service_client.config.target_host,
        namespace=temporal_env.client.namespace,
    )
    scripted_model.SCRIPT[:] = [message("Happy to help. What is your client ID?")]
    workflow_id = f"api-client-test-{uuid.uuid4()}"

    async with Worker(
        worker_client,
        task_queue=TASK_QUEUE,
        workflows=[WealthManagementWorkflow],
        activities=[stub_delete_conversation, stub_append_chat_interaction],
    ):
        await api_client.start_chat(api, workflow_id, TASK_QUEUE)
        await api_client.send_prompt(api, workflow_id, "Who are my beneficiaries?")

        handle = worker_client.get_workflow_handle(workflow_id)
        for _ in range(80):
            if history := await handle.query(WealthManagementWorkflow.get_chat_history):
                break
            await asyncio.sleep(0.25)
        assert [(h.user_prompt, h.text_response) for h in history] == [
            ("Who are my beneficiaries?", "Happy to help. What is your client ID?")
        ]

        await api_client.end_chat(api, workflow_id)
        await asyncio.wait_for(handle.result(), timeout=10)

    assert scripted_model.SCRIPT == []


def test_the_api_knows_this_ports_task_queue(monkeypatch):
    """./startlocalapi.sh openai_agents starts chats where this port's worker listens by default."""
    from api.frameworks import FRAMEWORKS
    from common.client_helper import ClientHelper
    from durable.task_queues import DEFAULT_TASK_QUEUE

    monkeypatch.delenv("TEMPORAL_TASK_QUEUE", raising=False)
    assert FRAMEWORKS["openai_agents"].task_queue == ClientHelper(default_task_queue=DEFAULT_TASK_QUEUE).taskQueue
