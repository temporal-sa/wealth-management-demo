"""Shared setup for the live tests, which call the real model (see live_*.py).

The model is called through the real invoke_model activity, wrapped to record what each
agent said, on its own task queue as in the worker. The event stream is kept in memory
and the chaos flags read as off, so no Redis is needed.
"""

import os

import litellm
import pytest
from temporalio import activity
from temporalio.worker import Worker

import temporal_supervisor.chaos as chaos
from common.agent_constants import BENE_AGENT_NAME, INVEST_AGENT_NAME, OPEN_ACCOUNT_AGENT_NAME, SUPERVISOR_AGENT_NAME
from common.agent_loop import ModelRequest, ModelResponse
from common.chaos_manager import ChaosFlag
from common.llm_config import llm_model
from common.task_queues import TASK_QUEUE_LLM
from temporal_supervisor.activities.model import invoke_model
from temporal_supervisor.workflows.supervisor_workflow import WealthManagementWorkflow
from tests.scripted_model import send

RUNS = max(1, int(os.getenv("LIVE_TEST_RUNS", "1")))

_missing = litellm.validate_environment(model=llm_model()).get("missing_keys") or []
requires_model_key = pytest.mark.skipif(
    bool(_missing), reason=f"{', '.join(_missing)} not set for {llm_model()}: source ./setllmkey.sh first")

# What each agent said, as (agent name, text), from every model call's output. The trace
# only records handoffs and tool calls, and the reply concatenates every agent's messages.
AGENT_MESSAGES: list = []
AGENT_BY_INSTRUCTIONS = {
    "You are a beneficiary agent": BENE_AGENT_NAME,
    "You are an investment agent": INVEST_AGENT_NAME,
    "You only help with wealth management": SUPERVISOR_AGENT_NAME,
    "You are responsible for handling the opening a new investment account": OPEN_ACCOUNT_AGENT_NAME,
}


def agent_name(system: str) -> str:
    return next((name for marker, name in AGENT_BY_INSTRUCTIONS.items() if marker in system), "Other Agent")


@activity.defn(name="invoke_model")
async def recording_invoke_model(request: ModelRequest) -> ModelResponse:
    response = await invoke_model(request)
    name = agent_name(request.system)
    if response.content:
        AGENT_MESSAGES.append((name, response.content))
    for call in response.tool_calls:
        AGENT_MESSAGES.append((name, f"<calls {call.name}>"))
    return response


def live_model_worker(client) -> Worker:
    return Worker(client, task_queue=TASK_QUEUE_LLM, activities=[recording_invoke_model])


@pytest.fixture
def chaos_off(monkeypatch):
    """Chaos flags read as off. They fail open without Redis anyway, but a local Redis
    left with a flag on would otherwise break the run."""
    async def is_enabled(flag: ChaosFlag) -> bool:
        return False

    monkeypatch.setattr(chaos, "is_enabled", is_enabled)


class Conversation:
    """Talks to a chat workflow and keeps a transcript of every turn for the test output."""

    def __init__(self, handle, run: int):
        self.handle = handle
        self.run = run
        self.transcript: list[str] = []

    async def say(self, text: str):
        AGENT_MESSAGES.clear()
        reply = await send(self.handle, text)
        self.transcript.extend([f"Customer: {text}", f"Agent: {reply.text_response}",
                                *[f"  trace: {line}" for line in (reply.agent_trace or "").splitlines()],
                                *[f"  [{name}]: {said}" for name, said in AGENT_MESSAGES]])
        return reply

    def context(self) -> str:
        return f"\nRun {self.run} of {RUNS} ({llm_model()}):\n" + "\n".join(self.transcript)

    async def end(self):
        await self.handle.signal(WealthManagementWorkflow.end_workflow)
        await self.handle.result()
        print(self.context())
