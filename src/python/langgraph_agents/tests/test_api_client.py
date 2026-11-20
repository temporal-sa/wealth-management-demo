"""The shared API's Temporal calls work against this framework's real chat workflow.

The API (src/python/api) connects without this framework's workflow class: it uses the
contract names and Temporal's Pydantic data converter, the same converter this framework's
worker uses (durable/connection.py; the temporal_env fixture uses it too). This test
makes the API's exact calls, from ``api.client``, to the real ``WealthManagementWorkflow``
run with Temporal's LangGraph plugin and the scripted model, and checks the workflow decodes the message, answers it,
and ends.

Requires the Temporal test server (downloaded automatically on first run). No model key
or Redis needed.
"""

import asyncio
import uuid

from api import client as api_client
from durable.activities.event_stream_activities import EventStreamActivities, InMemoryEventStream
from durable.workflows.supervisor_workflow import WealthManagementWorkflow
from tests.scripted_model import SCRIPT, message, workers

TASK_QUEUE = "test-api-client"
REPLY = "Happy to help. What is your client ID?"


async def test_the_api_client_starts_messages_and_ends_the_real_chat_workflow(temporal_env, monkeypatch):
    monkeypatch.delenv("USE_CLAIM_CHECK", raising=False)
    client = temporal_env.client
    events = EventStreamActivities(InMemoryEventStream())
    SCRIPT[:] = [message(REPLY)]
    workflow_id = f"langgraph-temporal-agent-{uuid.uuid4().hex[:12]}"

    api = await api_client.connect(
        target_host=client.service_client.config.target_host,
        namespace=client.namespace,
    )
    async with workers(client, TASK_QUEUE, [events.delete_conversation, events.append_chat_interaction]):
        await api_client.start_chat(api, workflow_id, TASK_QUEUE)
        await api_client.send_prompt(api, workflow_id, "Who are my beneficiaries?")

        handle = client.get_workflow_handle(workflow_id)
        for _ in range(100):
            history = await handle.query(WealthManagementWorkflow.get_chat_history)
            if history:
                break
            await asyncio.sleep(0.1)
        assert [(t.user_prompt, t.text_response) for t in history] == [("Who are my beneficiaries?", REPLY)]
        assert SCRIPT == []

        await api_client.end_chat(api, workflow_id)
        await asyncio.wait_for(handle.result(), timeout=10)


def test_the_api_knows_this_ports_task_queue():
    """./startlocalapi.sh langgraph_agents starts chats where this framework's worker listens by default."""
    from api.frameworks import FRAMEWORKS
    from durable.task_queues import DEFAULT_TASK_QUEUE

    assert FRAMEWORKS["langgraph_agents"].task_queue == DEFAULT_TASK_QUEUE
