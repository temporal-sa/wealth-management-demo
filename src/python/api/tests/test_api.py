"""The API's endpoints start, message and end a chat workflow by the Temporal contracts.

Calls the real FastAPI app over HTTP. The chat workflow is a stub registered under the
contract names, run by a worker with Temporal's default data converter rather than the
Pydantic one, so the tests also show the API's payloads are plain JSON that any port's
worker can read. Redis is not used: the chat history test replaces the event stream.

Requires the Temporal test server (downloaded automatically on first run). No model key,
Redis or running Temporal service needed. The port tests check the same calls against
the real chat workflow (src/python/openai_agents/tests/test_api_client.py).
"""

import asyncio
import os
import uuid
from contextlib import contextmanager
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from temporalio import workflow
from temporalio.client import WorkflowExecutionStatus
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import UnsandboxedWorkflowRunner, Worker

TASK_QUEUE = "test-api"


@workflow.defn(name="WealthManagementWorkflow")
class StubChatWorkflow:
    """Records each message it is sent, exactly as decoded, until it is ended."""

    def __init__(self) -> None:
        self.messages: list = []
        self.ended = False

    @workflow.run
    async def run(self) -> list:
        await workflow.wait_condition(lambda: self.ended)
        return self.messages

    @workflow.signal(name="process_user_message")
    async def process_user_message(self, message: dict) -> None:
        self.messages.append(message)

    @workflow.signal(name="end_workflow")
    async def end_workflow(self) -> None:
        self.ended = True

    @workflow.query(name="messages")
    def get_messages(self) -> list:
        return self.messages


@pytest.fixture(scope="module")
async def temporal_env():
    async with await WorkflowEnvironment.start_local() as env:
        async with Worker(
            env.client,
            task_queue=TASK_QUEUE,
            workflows=[StubChatWorkflow],
            workflow_runner=UnsandboxedWorkflowRunner(),
        ):
            yield env


@contextmanager
def api(temporal_env, tmp_path_factory, **settings):
    """The API, connected to the test server, with these environment settings (None unsets)."""
    empty_config = tmp_path_factory.mktemp("temporal") / "temporal.toml"
    empty_config.write_text("")
    with pytest.MonkeyPatch.context() as env:
        env.setenv("TEMPORAL_CONFIG_FILE", str(empty_config))
        env.setenv("TEMPORAL_ADDRESS", temporal_env.client.service_client.config.target_host)
        env.setenv("TEMPORAL_NAMESPACE", temporal_env.client.namespace)
        for name in ("USE_CLAIM_CHECK", "CHAT_PORT", "CHAT_WORKFLOW_ID_PREFIX", "TEMPORAL_TASK_QUEUE"):
            env.delenv(name, raising=False)
        for name, value in settings.items():
            env.setenv(name, value)
        from api.main import app

        with TestClient(app) as client:
            yield client


@pytest.fixture(scope="module")
def http(temporal_env, tmp_path_factory):
    """The API, starting chats on TASK_QUEUE."""
    with api(temporal_env, tmp_path_factory, TEMPORAL_TASK_QUEUE=TASK_QUEUE) as client:
        yield client


async def post(http, path: str, **params) -> dict:
    # TestClient blocks, so run it off the event loop the worker runs on.
    response = await asyncio.to_thread(http.post, path, params=params)
    response.raise_for_status()
    return response.json()


async def start_chat(http) -> str:
    workflow_id = f"api-test-{uuid.uuid4()}"
    assert await post(http, "/start-workflow", workflow_id=workflow_id) == {"message": "Workflow started."}
    return workflow_id


async def test_start_workflow_starts_the_chat_workflow_on_the_task_queue(http, temporal_env):
    workflow_id = await start_chat(http)

    description = await temporal_env.client.get_workflow_handle(workflow_id).describe()
    assert description.workflow_type == "WealthManagementWorkflow"
    assert description.task_queue == TASK_QUEUE
    assert description.status == WorkflowExecutionStatus.RUNNING


async def test_send_prompt_sends_process_user_message_with_the_contract_payload(http, temporal_env):
    workflow_id = await start_chat(http)

    response = await post(http, "/send-prompt", workflow_id=workflow_id, prompt="Who are my beneficiaries?")

    assert response == {"response": "Message sent"}
    handle = temporal_env.client.get_workflow_handle(workflow_id)
    for _ in range(40):
        if messages := await handle.query("messages"):
            break
        await asyncio.sleep(0.25)
    assert messages == [{"user_input": "Who are my beneficiaries?"}]


async def test_end_chat_sends_end_workflow(http, temporal_env):
    workflow_id = await start_chat(http)

    assert await post(http, "/end-chat", workflow_id=workflow_id) == {"message": "End chat signal sent."}
    handle = temporal_env.client.get_workflow_handle(workflow_id)
    assert await asyncio.wait_for(handle.result(), timeout=10) == []


async def test_start_workflow_reuses_the_id_of_an_ended_chat(http, temporal_env):
    workflow_id = await start_chat(http)
    handle = temporal_env.client.get_workflow_handle(workflow_id)
    first_run = (await handle.describe()).run_id
    await post(http, "/end-chat", workflow_id=workflow_id)
    await asyncio.wait_for(handle.result(), timeout=10)

    assert await post(http, "/start-workflow", workflow_id=workflow_id) == {"message": "Workflow started."}

    description = await temporal_env.client.get_workflow_handle(workflow_id).describe()
    assert description.run_id != first_run
    assert description.status == WorkflowExecutionStatus.RUNNING


async def test_send_prompt_to_an_unknown_chat_reports_an_error(http):
    response = await post(http, "/send-prompt", workflow_id=f"missing-{uuid.uuid4()}", prompt="Hello")
    assert response["response"].startswith("Error:")


async def test_end_chat_for_an_unknown_chat_returns_nothing(http):
    assert await post(http, "/end-chat", workflow_id=f"missing-{uuid.uuid4()}") == {}


async def test_get_chat_history_returns_the_events_from_the_index(http, monkeypatch):
    events = [{"type": "chat_interaction", "content": {"user_prompt": "Hi", "text_response": "Hello"}}]
    calls = []

    async def fake_get_events_from_index(self, workflow_id, from_index):
        calls.append((workflow_id, from_index))
        return events

    from common.event_stream_manager import EventStreamManager
    monkeypatch.setattr(EventStreamManager, "get_events_from_index", fake_get_events_from_index)

    response = await asyncio.to_thread(http.get, "/get-chat-history", params={"workflow_id": "chat-1", "from_index": 3})

    assert response.json() == events
    assert calls == [("chat-1", 3)]


async def test_set_chaos_rejects_an_unknown_flag(http):
    response = await asyncio.to_thread(http.post, "/chaos", params={"flag": "not_a_flag", "enabled": True})
    assert response.status_code == 400


async def test_config_reports_the_default_port(http):
    response = await asyncio.to_thread(http.get, "/config")
    assert response.json() == {
        "port": "openai_agents",
        "label": "OpenAI Agents SDK",
        "task_queue": TASK_QUEUE,
        "workflow_id_prefix": "oai-temporal-agent-",
    }


async def test_chat_port_picks_the_ports_task_queue_and_workflow_id_prefix(temporal_env, tmp_path_factory):
    with api(temporal_env, tmp_path_factory, CHAT_PORT="pyai") as client:
        config = (await asyncio.to_thread(client.get, "/config")).json()
        assert config == {
            "port": "pyai",
            "label": "Pydantic AI",
            "task_queue": "PY-AI-Supervisor",
            "workflow_id_prefix": "pyai-temporal-agent-",
        }

        workflow_id = config["workflow_id_prefix"] + uuid.uuid4().hex[:12]
        assert await post(client, "/start-workflow", workflow_id=workflow_id) == {"message": "Workflow started."}

    handle = temporal_env.client.get_workflow_handle(workflow_id)
    assert (await handle.describe()).task_queue == "PY-AI-Supervisor"
    await handle.terminate()


async def test_settings_override_the_ports_values(temporal_env, tmp_path_factory):
    with api(temporal_env, tmp_path_factory, CHAT_PORT="pyai", TEMPORAL_TASK_QUEUE="my-queue",
             CHAT_WORKFLOW_ID_PREFIX="demo-") as client:
        config = (await asyncio.to_thread(client.get, "/config")).json()
    assert (config["task_queue"], config["workflow_id_prefix"]) == ("my-queue", "demo-")


def test_an_unknown_chat_port_is_rejected(monkeypatch):
    from api.ports import selected_port
    monkeypatch.setenv("CHAT_PORT", "nope")
    with pytest.raises(ValueError, match="openai_agents, pyai, strands_agents, google_adk"):
        selected_port()


async def test_the_strands_port_needs_nothing_extra(temporal_env, tmp_path_factory):
    """Like the other ports, the Strands Agents port confirms deletes in the chat, so the
    API serves it with the same endpoints: only its task queue and prefix differ."""
    with api(temporal_env, tmp_path_factory, CHAT_PORT="strands_agents") as client:
        assert (await asyncio.to_thread(client.get, "/config")).json() == {
            "port": "strands_agents",
            "label": "Strands Agents",
            "task_queue": "wealth-management-strands",
            "workflow_id_prefix": "strands-temporal-agent-",
        }
        assert (await asyncio.to_thread(client.get, "/pending-approval", params={"workflow_id": "x"})).status_code == 404
