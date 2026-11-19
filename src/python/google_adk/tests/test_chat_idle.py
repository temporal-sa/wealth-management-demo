"""A chat nobody uses ends by itself: with no customer message and no account-opening
status update for CHAT_IDLE_TIMEOUT (1 hour), the WealthManagementWorkflow completes,
as it does on End Chat.

Runs the real workflow (see chat_harness.py) on Temporal's time-skipping test server
(downloaded automatically on first run), so the hour passes instantly. No GEMINI_API_KEY
or Redis needed: the model is never called.
"""

from datetime import timedelta

from temporalio.client import WorkflowExecutionStatus
from temporalio.testing import WorkflowEnvironment

from common.chat_idle import CHAT_IDLE_TIMEOUT
from tests.chat_harness import chat_workers, start_chat


async def test_idle_chat_completes_after_the_idle_timeout():
    async with await WorkflowEnvironment.start_time_skipping() as env:
        async with chat_workers(env.client) as client:
            handle = await start_chat(client)

            # Still waiting for the customer a minute before the timeout
            await env.sleep(CHAT_IDLE_TIMEOUT - timedelta(minutes=1))
            assert (await handle.describe()).status == WorkflowExecutionStatus.RUNNING

            # Then it ends by itself, normally
            await handle.result()
            description = await handle.describe()
            assert description.status == WorkflowExecutionStatus.COMPLETED
            assert description.close_time - description.start_time >= CHAT_IDLE_TIMEOUT
