"""A chat nobody uses ends by itself: with no customer message and no account-opening
status update for CHAT_IDLE_TIMEOUT (1 hour), the WealthManagementWorkflow completes,
as it does on End Chat.

Runs the real workflow on Temporal's time-skipping test server (downloaded automatically
on first run), so the hour passes instantly. No model key or Redis needed: the model is
never called, and the one activity the chat runs before waiting is a stub.
"""

import uuid
from datetime import timedelta

from temporalio import activity
from temporalio.client import WorkflowExecutionStatus
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from common.chat_idle import CHAT_IDLE_TIMEOUT
from durable.workflows.supervisor_workflow import WealthManagementWorkflow
from tests.scripted_model import scripted_client

TASK_QUEUE = "test-chat-idle"


@activity.defn(name="delete_conversation")
async def stub_delete_conversation(workflow_id: str) -> bool:
    return True


async def test_idle_chat_completes_after_the_idle_timeout():
    async with await WorkflowEnvironment.start_time_skipping() as env:
        client = scripted_client(env.client)
        async with Worker(client, task_queue=TASK_QUEUE, workflows=[WealthManagementWorkflow],
                          activities=[stub_delete_conversation]):
            handle = await client.start_workflow(
                WealthManagementWorkflow.run, id=f"chat-idle-test-{uuid.uuid4()}", task_queue=TASK_QUEUE
            )

            # Still waiting for the customer a minute before the timeout
            await env.sleep(CHAT_IDLE_TIMEOUT - timedelta(minutes=1))
            assert (await handle.describe()).status == WorkflowExecutionStatus.RUNNING

            # Then it ends by itself, normally
            await handle.result()
            description = await handle.describe()
            assert description.status == WorkflowExecutionStatus.COMPLETED
            assert description.close_time - description.start_time >= CHAT_IDLE_TIMEOUT
