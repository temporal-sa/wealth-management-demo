"""The API's endpoints start, message and end a chat workflow by the Temporal contracts.

Calls the real FastAPI app over HTTP. The chat workflow is a stub registered under the
contract names, run by a worker with Temporal's default data converter rather than the
Pydantic one, so the tests also show the API's payloads are plain JSON that any framework's
worker can read. Redis is not used: the chat history test replaces the event stream.

Requires the Temporal test server (downloaded automatically on first run). No model key,
Redis or running Temporal service needed. The frameworks' tests check the same calls against
the real chat workflow (src/python/openai_agents/tests/test_api_client.py).
"""

import asyncio
import os
import re
import subprocess
import sys
import uuid
from contextlib import contextmanager
from dataclasses import replace
from datetime import timedelta
from pathlib import Path

import httpx
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


@workflow.defn(name="OpenInvestmentAccountWorkflow")
class StubOpenAccountWorkflow:
    """An account opening that stays in the state it is started with until compliance approves it."""

    def __init__(self) -> None:
        self.state = ""

    @workflow.run
    async def run(self, state: str) -> str:
        self.state = state
        await workflow.wait_condition(lambda: self.state == "Approved")
        return self.state

    @workflow.query(name="get_current_state")
    def get_current_state(self) -> str:
        return self.state

    @workflow.signal(name="compliance_approved")
    async def compliance_approved(self) -> None:
        self.state = "Approved"


@pytest.fixture(scope="module")
async def temporal_env():
    async with await WorkflowEnvironment.start_local() as env:
        async with Worker(
            env.client,
            task_queue=TASK_QUEUE,
            workflows=[StubChatWorkflow, StubOpenAccountWorkflow],
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
        for name in ("USE_CLAIM_CHECK", "AI_FRAMEWORK", "CHAT_WORKFLOW_ID_PREFIX", "TEMPORAL_TASK_QUEUE"):
            env.delenv(name, raising=False)
        for name, value in settings.items():
            env.setenv(name, value)
        from api.main import app

        with TestClient(app) as client:
            yield client


@pytest.fixture(scope="module")
def http(temporal_env, tmp_path_factory):
    """The API serving the OpenAI Agents framework, starting chats on TASK_QUEUE."""
    with api(temporal_env, tmp_path_factory, AI_FRAMEWORK="openai_agents", TEMPORAL_TASK_QUEUE=TASK_QUEUE) as client:
        yield client


async def post(http, path: str, **params) -> dict:
    # TestClient blocks, so run it off the event loop the worker runs on.
    response = await asyncio.to_thread(http.post, path, params=params)
    response.raise_for_status()
    return response.json()


async def start_chat(http) -> str:
    response = await post(http, "/api/start-workflow")
    assert response["message"] == "Workflow started."
    return response["workflow_id"]


@contextmanager
def other_browser(http):
    """The same client with an empty cookie jar, as another browser would be."""
    saved = http.cookies
    http.cookies = httpx.Cookies()
    try:
        yield http
    finally:
        http.cookies = saved


async def test_start_workflow_starts_the_chat_workflow_on_the_task_queue(http, temporal_env):
    workflow_id = await start_chat(http)

    description = await temporal_env.client.get_workflow_handle(workflow_id).describe()
    assert description.workflow_type == "WealthManagementWorkflow"
    assert description.task_queue == TASK_QUEUE
    assert description.status == WorkflowExecutionStatus.RUNNING


async def test_send_prompt_sends_process_user_message_with_the_contract_payload(http, temporal_env):
    workflow_id = await start_chat(http)

    response = await post(http, "/api/send-prompt", workflow_id=workflow_id, prompt="Who are my beneficiaries?")

    assert response == {"response": "Message sent"}
    handle = temporal_env.client.get_workflow_handle(workflow_id)
    for _ in range(40):
        if messages := await handle.query("messages"):
            break
        await asyncio.sleep(0.25)
    assert messages == [{"user_input": "Who are my beneficiaries?"}]


async def test_end_chat_sends_end_workflow(http, temporal_env):
    workflow_id = await start_chat(http)

    assert await post(http, "/api/end-chat", workflow_id=workflow_id) == {"message": "End chat signal sent."}
    handle = temporal_env.client.get_workflow_handle(workflow_id)
    assert await asyncio.wait_for(handle.result(), timeout=10) == []


async def test_each_browser_gets_a_session_cookie_and_chat_ids_that_carry_it(http):
    with other_browser(http):
        workflow_id = await start_chat(http)
        session = http.cookies.get("wm_session")
        assert re.fullmatch(r"[0-9a-f]{32}", session)
        assert re.fullmatch(rf"oai-temporal-agent-session-{session}-chat-[0-9a-f]{{16}}", workflow_id)
        # The same browser keeps its session
        assert session_from(await start_chat(http)) == session


def session_from(workflow_id: str) -> str:
    return re.search(r"session-([0-9a-f]{32})-chat-", workflow_id).group(1)


async def test_another_browsers_chat_is_not_found(http, temporal_env):
    workflow_id = await start_chat(http)
    with other_browser(http):
        for method, path, params in (
            ("get", "/api/get-chat-history", {"workflow_id": workflow_id}),
            ("post", "/api/send-prompt", {"workflow_id": workflow_id, "prompt": "Hi"}),
            ("post", "/api/end-chat", {"workflow_id": workflow_id}),
            ("post", "/api/approve-compliance", {"workflow_id": workflow_id}),
        ):
            response = await asyncio.to_thread(getattr(http, method), path, params=params)
            assert response.status_code == 404, path
    # Nothing reached the chat
    handle = temporal_env.client.get_workflow_handle(workflow_id)
    assert await handle.query("messages") == []
    assert (await handle.describe()).status == WorkflowExecutionStatus.RUNNING
    await handle.terminate()


async def test_chaos_flags_are_set_for_the_callers_session(http, monkeypatch):
    from api import main
    sessions = []

    class RecordingChaosManager:
        def __init__(self, session_id=None):
            sessions.append(session_id)

        async def set_enabled(self, flag, enabled):
            pass

        async def close(self):
            pass

    monkeypatch.setattr(main, "ChaosManager", RecordingChaosManager)
    await post(http, "/api/chaos", flag="tool_down", enabled=True)
    with other_browser(http):
        await post(http, "/api/chaos", flag="tool_down", enabled=True)
        other = http.cookies.get("wm_session")
    assert sessions == [http.cookies.get("wm_session"), other] and sessions[0] != sessions[1]


async def unstarted_chat_id(http) -> str:
    """An ID of this browser session's form that no chat was started with."""
    await asyncio.to_thread(http.get, "/api/config")  # makes sure the browser has its session cookie
    return f"oai-temporal-agent-session-{http.cookies.get('wm_session')}-chat-{uuid.uuid4().hex[:16]}"


async def test_send_prompt_to_an_unknown_chat_reports_an_error(http):
    response = await post(http, "/api/send-prompt", workflow_id=await unstarted_chat_id(http), prompt="Hello")
    assert response["response"].startswith("Error:")


async def test_end_chat_for_an_unknown_chat_returns_nothing(http):
    assert await post(http, "/api/end-chat", workflow_id=await unstarted_chat_id(http)) == {}


async def _start_opening(temporal_env, workflow_id: str, state: str):
    return await temporal_env.client.start_workflow(
        "OpenInvestmentAccountWorkflow", state, id=workflow_id, task_queue=TASK_QUEUE)


async def _wait_until_listed(temporal_env, ids: list[str]) -> None:
    """Visibility is eventually consistent: wait until the search finds these workflows."""
    quoted = ", ".join(f"'{i}'" for i in ids)
    for _ in range(50):
        found = [w.id async for w in temporal_env.client.list_workflows(f"WorkflowId IN ({quoted})")]
        if len(found) == len(ids):
            return
        await asyncio.sleep(0.1)
    raise AssertionError(f"Not listed: {ids}")


async def test_approve_compliance_signals_only_this_chats_openings_waiting_for_review(http, temporal_env):
    chat_id = await start_chat(http)
    waiting = await _start_opening(temporal_env, f"OpenAccount-{chat_id}-123-Vacation account-1", "Waiting Compliance Review")
    in_kyc = await _start_opening(temporal_env, f"OpenAccount-{chat_id}-123-College-2", "Waiting KYC")
    other_chat = await _start_opening(temporal_env, f"OpenAccount-{chat_id}0-123-Vacation-1", "Waiting Compliance Review")
    await _wait_until_listed(temporal_env, [waiting.id, in_kyc.id, other_chat.id])

    response = await asyncio.to_thread(http.post, "/api/approve-compliance", params={"workflow_id": chat_id})

    assert response.status_code == 200
    assert response.json() == {"approved": [waiting.id]}
    assert await waiting.result() == "Approved"
    assert await in_kyc.query("get_current_state") == "Waiting KYC"
    assert await other_chat.query("get_current_state") == "Waiting Compliance Review"
    for handle in (in_kyc, other_chat):
        await handle.terminate()


async def test_approve_compliance_with_nothing_waiting_approves_nothing(http):
    chat_id = await start_chat(http)
    response = await asyncio.to_thread(http.post, "/api/approve-compliance", params={"workflow_id": chat_id})
    assert response.json() == {"approved": []}


async def test_approve_compliance_rejects_an_id_that_isnt_this_sessions_chat(http):
    response = await asyncio.to_thread(http.post, "/api/approve-compliance", params={"workflow_id": "x' OR WorkflowId != '"})
    assert response.status_code == 404


async def test_get_chat_history_returns_the_events_from_the_index(http, monkeypatch):
    events = [{"type": "chat_interaction", "content": {"user_prompt": "Hi", "text_response": "Hello"}}]
    calls = []

    async def fake_get_events_from_index(self, workflow_id, from_index):
        calls.append((workflow_id, from_index))
        return events

    from common.event_stream_manager import EventStreamManager
    monkeypatch.setattr(EventStreamManager, "get_events_from_index", fake_get_events_from_index)

    chat_id = await start_chat(http)
    response = await asyncio.to_thread(http.get, "/api/get-chat-history", params={"workflow_id": chat_id, "from_index": 3})

    assert response.json() == events
    assert calls == [(chat_id, 3)]


async def test_set_chaos_rejects_an_unknown_flag(http):
    response = await asyncio.to_thread(http.post, "/api/chaos", params={"flag": "not_a_flag", "enabled": True})
    assert response.status_code == 400


async def config_of(client) -> list[dict]:
    return (await asyncio.to_thread(client.get, "/api/config")).json()["frameworks"]


async def test_config_reports_the_framework_and_that_its_worker_runs(http):
    assert await config_of(http) == [{
        "framework": "openai_agents",
        "label": "OpenAI Agents SDK",
        "language": "Python",
        "short_label": "OpenAI Agents SDK",
        "task_queue": TASK_QUEUE,
        "workflow_id_prefix": "oai-temporal-agent-",
        "available": True,
    }]


async def test_ai_framework_picks_its_task_queue_and_workflow_id_prefix(temporal_env, tmp_path_factory):
    with api(temporal_env, tmp_path_factory, AI_FRAMEWORK="pyai") as client:
        assert await config_of(client) == [{
            "framework": "pyai",
            "label": "Pydantic AI",
            "language": "Python",
            "short_label": "Pydantic AI",
            "task_queue": "PYAI-Supervisor",
            "workflow_id_prefix": "pyai-temporal-agent-",
            "available": False,  # no worker polls PYAI-Supervisor here
        }]

        workflow_id = await start_chat(client)
        assert workflow_id.startswith("pyai-temporal-agent-session-")

    handle = temporal_env.client.get_workflow_handle(workflow_id)
    assert (await handle.describe()).task_queue == "PYAI-Supervisor"
    await handle.terminate()


async def test_settings_override_the_frameworks_values(temporal_env, tmp_path_factory):
    with api(temporal_env, tmp_path_factory, AI_FRAMEWORK="pyai", TEMPORAL_TASK_QUEUE="my-queue",
             CHAT_WORKFLOW_ID_PREFIX="demo-") as client:
        [config] = await config_of(client)
    assert (config["task_queue"], config["workflow_id_prefix"]) == ("my-queue", "demo-")


@contextmanager
def two_frameworks(temporal_env, tmp_path_factory, **settings):
    """The API serving OpenAI Agents and Pydantic AI, whose test worker polls TASK_QUEUE as OpenAI Agents' queue
    would. The override settings don't apply to several frameworks, so the stub queue is patched in."""
    from api import frameworks
    stub = replace(frameworks.FRAMEWORKS["openai_agents"], task_queue=TASK_QUEUE)
    with pytest.MonkeyPatch.context() as patch:
        patch.setitem(frameworks.FRAMEWORKS, "openai_agents", stub)
        with api(temporal_env, tmp_path_factory, AI_FRAMEWORK="openai_agents, pyai", **settings) as client:
            yield client


async def test_several_frameworks_are_listed_in_order_with_their_workers(temporal_env, tmp_path_factory):
    with two_frameworks(temporal_env, tmp_path_factory) as client:
        config = await config_of(client)
    assert [(f["framework"], f["task_queue"], f["available"]) for f in config] == [
        ("openai_agents", TASK_QUEUE, True), ("pyai", "PYAI-Supervisor", False)]


async def test_with_several_frameworks_a_chat_starts_on_the_one_asked_for(temporal_env, tmp_path_factory):
    with two_frameworks(temporal_env, tmp_path_factory) as client:
        pyai = (await post(client, "/api/start-workflow", framework="pyai"))["workflow_id"]
        oai = (await post(client, "/api/start-workflow", framework="openai_agents"))["workflow_id"]
        assert pyai.startswith("pyai-temporal-agent-session-") and oai.startswith("oai-temporal-agent-session-")
        assert session_from(pyai) == session_from(oai)  # one browser, one session, a chat in each tab

        # Each chat's ID says which framework it is: both are reachable through the same endpoints
        assert await post(client, "/api/send-prompt", workflow_id=oai, prompt="Hi") == {"response": "Message sent"}
        assert await post(client, "/api/end-chat", workflow_id=oai) == {"message": "End chat signal sent."}
        assert (await asyncio.to_thread(client.post, "/api/approve-compliance",
                                        params={"workflow_id": pyai})).json() == {"approved": []}
        with other_browser(client):
            response = await asyncio.to_thread(client.post, "/api/end-chat", params={"workflow_id": pyai})
            assert response.status_code == 404

    assert (await temporal_env.client.get_workflow_handle(pyai).describe()).task_queue == "PYAI-Supervisor"
    assert await asyncio.wait_for(temporal_env.client.get_workflow_handle(oai).result(), timeout=10) == [
        {"user_input": "Hi"}]
    await temporal_env.client.get_workflow_handle(pyai).terminate()


@pytest.mark.parametrize("framework", [None, "google_adk", "nope"])
async def test_with_several_frameworks_starting_a_chat_needs_one_of_them(temporal_env, tmp_path_factory, framework):
    with two_frameworks(temporal_env, tmp_path_factory) as client:
        params = {"framework": framework} if framework else {}
        response = await asyncio.to_thread(client.post, "/api/start-workflow", params=params)
    assert response.status_code == 400
    assert "This API serves: openai_agents, pyai" in response.json()["detail"]


async def test_with_several_frameworks_the_override_settings_are_ignored(temporal_env, tmp_path_factory):
    with two_frameworks(temporal_env, tmp_path_factory, TEMPORAL_TASK_QUEUE="my-queue",
                        CHAT_WORKFLOW_ID_PREFIX="demo-") as client:
        config = await config_of(client)
    assert [(f["task_queue"], f["workflow_id_prefix"]) for f in config] == [
        (TASK_QUEUE, "oai-temporal-agent-"), ("PYAI-Supervisor", "pyai-temporal-agent-")]


STABLE_FRAMEWORKS = ("openai_agents", "pyai", "strands_agents", "google_adk", "pure", "langgraph_agents", "vercel_ai", "google_adk_ts", "google_adk_go", "spring_ai", "strands_agents_ts", "openai_agents_ts")
EXPERIMENTAL_FRAMEWORKS = ("agent_framework_dotnet",)
EVERY_FRAMEWORK = STABLE_FRAMEWORKS + EXPERIMENTAL_FRAMEWORKS


@pytest.mark.parametrize("ai_framework", [None, "", "nope"])
def test_the_api_needs_a_known_ai_framework_and_lists_every_framework(monkeypatch, ai_framework):
    from api.frameworks import selected_frameworks
    if ai_framework is None:
        monkeypatch.delenv("AI_FRAMEWORK", raising=False)
    else:
        monkeypatch.setenv("AI_FRAMEWORK", ai_framework)
    with pytest.raises(ValueError) as error:
        selected_frameworks()
    assert all(f"  {name} " in str(error.value) for name in EVERY_FRAMEWORK)


@pytest.mark.parametrize("value, expected", [
    ("all", list(STABLE_FRAMEWORKS)), (" ALL ", list(STABLE_FRAMEWORKS)), ("pyai", ["pyai"]),
    ("agent_framework_dotnet", ["agent_framework_dotnet"]), ("pyai,agent_framework_dotnet", ["pyai", "agent_framework_dotnet"]),
    ("strands_agents,vercel_ai", ["strands_agents", "vercel_ai"]), (" go_first , pyai, pyai ", None),
    ("google_adk_go, pyai, google_adk_go", ["google_adk_go", "pyai"]),
])
def test_ai_framework_names_one_several_or_all(monkeypatch, value, expected):
    from api.frameworks import selected_frameworks
    monkeypatch.setenv("AI_FRAMEWORK", value)
    if expected is None:
        with pytest.raises(ValueError, match="Unknown AI framework 'go_first'"):
            selected_frameworks()
    else:
        assert [f.name for f in selected_frameworks()] == expected


def test_all_leaves_out_the_experimental_frameworks_unless_asked():
    from api.frameworks import names, valid_frameworks
    assert names("all") == list(STABLE_FRAMEWORKS)
    assert names("all", experimental=True) == list(EVERY_FRAMEWORK)
    assert names("agent_framework_dotnet") == ["agent_framework_dotnet"]
    assert names("experimental") == list(EXPERIMENTAL_FRAMEWORKS)
    assert names(" Experimental ") == list(EXPERIMENTAL_FRAMEWORKS)
    listed = valid_frameworks().splitlines()
    assert [line.split()[0] for line in listed if line.endswith("experimental: not in all")] == list(EXPERIMENTAL_FRAMEWORKS)


@pytest.mark.parametrize("args", [[], [""], ["nope"], ["pyai,nope"], [","]])
def test_the_start_scripts_check_stops_without_a_known_framework_and_lists_every_framework(args):
    """startlocalapi.sh and startcloudapi.sh run this check before starting uvicorn."""
    result = subprocess.run([sys.executable, "-m", "api.frameworks", "startlocalapi.sh", *args],
                            capture_output=True, text=True, cwd=Path(__file__).parents[2])
    assert result.returncode == 2
    assert "Usage: startlocalapi.sh <ai-framework>" in result.stderr
    assert all(f"  {name} " in result.stderr for name in EVERY_FRAMEWORK)


@pytest.mark.parametrize("name", [*EVERY_FRAMEWORK, "all", "experimental", "strands_agents,vercel_ai,google_adk_go"])
def test_the_start_scripts_check_accepts_every_framework_several_or_all(name):
    result = subprocess.run([sys.executable, "-m", "api.frameworks", "startlocalapi.sh", name],
                            capture_output=True, text=True, cwd=Path(__file__).parents[2])
    assert (result.returncode, result.stderr) == (0, "")


async def test_the_strands_framework_needs_nothing_extra(temporal_env, tmp_path_factory):
    """Like the other frameworks, the Strands Agents version confirms deletes in the chat, so the
    API serves it with the same endpoints: only its task queue and prefix differ."""
    with api(temporal_env, tmp_path_factory, AI_FRAMEWORK="strands_agents") as client:
        [config] = await config_of(client)
        assert (config["framework"], config["task_queue"], config["workflow_id_prefix"]) == (
            "strands_agents", "Strands-Supervisor", "strands-temporal-agent-")
        assert (await asyncio.to_thread(client.get, "/api/pending-approval", params={"workflow_id": "x"})).status_code == 404
