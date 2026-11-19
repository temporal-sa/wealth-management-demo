"""The shared API's Temporal calls work against this framework's real chat workflow.

The API (src/python/api) connects without this framework's plugin or workflow class: it uses
the contract names and the Pydantic data converter, which is the same converter
PydanticAIPlugin sets on a client. This test makes the API's exact calls, from
``api.client``, to the real ``WealthManagementWorkflow`` run with a scripted model, and
checks the workflow decodes the message, answers it, and ends.

Requires the Temporal test server (downloaded automatically on first run). No
OPENAI_API_KEY or Redis needed.
"""

import asyncio
import uuid
from typing import Any

from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
from pydantic_ai.messages import ModelMessage, ModelResponse, ToolCallPart, UserPromptPart
from pydantic_ai.models.function import AgentInfo, FunctionModel
from temporalio import activity
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import UnsandboxedWorkflowRunner, Worker

import durable.chaos as chaos
import pyai_agents.agents as agents
from api import client as api_client
from common.user_message import ChatInteraction
from durable.model_config import LLM_TASK_QUEUE
from durable.workflows.supervisor_workflow import WealthManagementWorkflow

TASK_QUEUE = "test-api-client"
REPLY = "Happy to help. What is your client ID?"
PROMPTS: list[str] = []
INTERACTIONS: list[ChatInteraction] = []


@activity.defn(name="get_task_queue_open_account")
async def stub_get_task_queue_open_account() -> str:
    return TASK_QUEUE


@activity.defn(name="delete_conversation")
async def stub_delete_conversation(workflow_id: str) -> bool:
    return True


@activity.defn(name="append_chat_interaction")
async def stub_append_chat_interaction(workflow_id: str, chat_interaction: ChatInteraction) -> int:
    INTERACTIONS.append(chat_interaction)
    return len(INTERACTIONS)


@activity.defn(name="append_status_update")
async def stub_append_status_update(workflow_id: str, status_update: Any) -> int:
    return 0


def _supervisor_asks_for_the_client_id(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
    assert "# Supervisor Agent (Router)" in (info.instructions or "")
    PROMPTS.extend(p.content for p in messages[-1].parts if isinstance(p, UserPromptPart))
    return ModelResponse(parts=[ToolCallPart("final_result_respond_to_user", {"response": REPLY})])


async def test_the_api_client_starts_messages_and_ends_the_real_chat_workflow(monkeypatch):
    async def chaos_off(_flag):
        return False

    monkeypatch.delenv("USE_CLAIM_CHECK", raising=False)
    monkeypatch.setattr(chaos, "is_enabled", chaos_off)
    monkeypatch.setattr(agents.agent_model, "wrapped", FunctionModel(_supervisor_asks_for_the_client_id))
    PROMPTS.clear()
    INTERACTIONS.clear()
    workflow_id = f"api-client-test-{uuid.uuid4()}"

    async with await WorkflowEnvironment.start_local(data_converter=pydantic_data_converter) as env:
        api = await api_client.connect(
            target_host=env.client.service_client.config.target_host,
            namespace=env.client.namespace,
        )
        # Unsandboxed, so the workflow sees the scripted model patched in above.
        worker = Worker(
            env.client,
            task_queue=TASK_QUEUE,
            workflows=[WealthManagementWorkflow],
            activities=[stub_get_task_queue_open_account, stub_delete_conversation,
                        stub_append_chat_interaction, stub_append_status_update],
            plugins=[PydanticAIPlugin()],
            workflow_runner=UnsandboxedWorkflowRunner(),
        )
        llm_worker = Worker(
            env.client,
            task_queue=LLM_TASK_QUEUE,
            activities=[a for agent in WealthManagementWorkflow.__pydantic_ai_agents__
                        for a in agent.temporal_activities],
        )
        async with worker, llm_worker:
            await api_client.start_chat(api, workflow_id, TASK_QUEUE)
            await api_client.send_prompt(api, workflow_id, "Who are my beneficiaries?")

            for _ in range(100):
                if INTERACTIONS:
                    break
                await asyncio.sleep(0.1)
            assert [(i.user_prompt, i.text_response) for i in INTERACTIONS] == [
                ("Who are my beneficiaries?", REPLY)
            ]
            assert PROMPTS == ["Who are my beneficiaries?"]

            await api_client.end_chat(api, workflow_id)
            await asyncio.wait_for(env.client.get_workflow_handle(workflow_id).result(), timeout=10)


def test_the_api_knows_this_ports_task_queue():
    """./startlocalapi.sh pyai starts chats where this framework's worker listens by default."""
    from api.frameworks import FRAMEWORKS
    from durable.task_queues import DEFAULT_TASK_QUEUE

    assert FRAMEWORKS["pyai"].task_queue == DEFAULT_TASK_QUEUE
