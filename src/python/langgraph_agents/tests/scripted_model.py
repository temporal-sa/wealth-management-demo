"""A model for tests that replays a script instead of calling Gemini.

Every agent node calls ``lg_agents.llm.complete``; the ``scripted`` fixture replaces it. In the
Temporal tests the agent nodes run as activities in the test process, so the replacement applies
there too.

Set ``SCRIPT`` to the model's replies, in the order the graph asks for them. Each step is a handoff
to the named agent, a tool call, or a message to the customer. A handoff or tool the active agent
doesn't offer fails the test. ``INSTRUCTIONS`` records the system prompt of every model call.
"""

import asyncio
import contextlib
import uuid

from langchain_core.messages import AIMessage
from temporalio.client import Client
from temporalio.worker import Worker

from common.user_message import ProcessUserMessageInput
from durable.run_worker import langgraph_plugin
from durable.task_queues import TASK_QUEUE_LLM
from durable.workflows.open_account_workflow import OpenInvestmentAccountWorkflow
from durable.workflows.supervisor_workflow import WealthManagementWorkflow
from lg_agents import llm
from lg_agents.agents import slug

SCRIPT: list = []
INSTRUCTIONS: list = []


def handoff(agent_name: str) -> tuple:
    return ("handoff", agent_name)


def tool(name: str, **arguments) -> tuple:
    return ("tool", name, arguments)


def message(text: str) -> tuple:
    return ("message", text)


async def scripted_complete(system, messages, tools, max_retries=0) -> AIMessage:
    INSTRUCTIONS.append(system)
    kind, value, *args = SCRIPT.pop(0)
    offered = [t["function"]["name"] for t in tools]
    call_id = f"call-{uuid.uuid4()}"
    if kind == "handoff":
        name = "transfer_to_" + slug(value)
        assert name in offered, f"the active agent can't hand off to {value}: it offers {offered}"
        return AIMessage("", tool_calls=[{"name": name, "args": {}, "id": call_id}])
    if kind == "tool":
        assert value in offered, f"the active agent has no tool {value}: it offers {offered}"
        return AIMessage("", tool_calls=[{"name": value, "args": args[0], "id": call_id}])
    return AIMessage(value)


def use_script(monkeypatch) -> None:
    """Replace the model with the script, empty (the conftest's ``scripted`` fixture does this for every test)."""
    SCRIPT.clear()
    INSTRUCTIONS.clear()
    monkeypatch.setattr(llm, "complete", scripted_complete)


@contextlib.asynccontextmanager
async def workers(client: Client, task_queue: str, activities: list, open_account: bool = False):
    """The chat worker and the model worker, sharing one LangGraph plugin, as run_worker.py runs them."""
    plugin = langgraph_plugin()
    workflows = [WealthManagementWorkflow, *([OpenInvestmentAccountWorkflow] if open_account else [])]
    async with Worker(client, task_queue=task_queue, workflows=workflows, activities=activities,
                      plugins=[plugin]), \
               Worker(client, task_queue=TASK_QUEUE_LLM, plugins=[plugin]):
        yield


async def send(handle, prompt: str, timeout: float = 60):
    """Send a customer message and return the agents' reply once it has been processed."""
    count = len(await handle.query(WealthManagementWorkflow.get_chat_history))
    await handle.signal(WealthManagementWorkflow.process_user_message, ProcessUserMessageInput(user_input=prompt))
    for _ in range(int(timeout / 0.25)):
        history = await handle.query(WealthManagementWorkflow.get_chat_history)
        if len(history) > count:
            return history[-1]
        await asyncio.sleep(0.25)
    raise AssertionError(f"no reply to {prompt!r}")
