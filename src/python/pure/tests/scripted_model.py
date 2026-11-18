"""A model for workflow tests that replays a script instead of calling a provider.

The chat workflow runs every model call as the ``invoke_model`` activity, so the test
model is just another activity registered under that name, on the model task queue.

Set ``SCRIPT`` to the model's responses, in the order the workflow asks for them. Each
step is a handoff to the named agent, a tool call, or a message to the customer. A
handoff the active agent can't make fails the test. ``INSTRUCTIONS`` records the system
instructions of every model call. Run ``model_worker`` alongside the chat worker and
talk to the workflow with ``send``.
"""

import asyncio
import json
import uuid

from temporalio import activity
from temporalio.client import Client
from temporalio.worker import Worker

from common.agent_loop import Agent, ModelRequest, ModelResponse, ToolCall
from common.task_queues import TASK_QUEUE_LLM
from common.user_message import ProcessUserMessageInput
from temporal_supervisor.workflows.supervisor_workflow import WealthManagementWorkflow

SCRIPT: list = []
INSTRUCTIONS: list = []


def handoff(agent_name: str) -> tuple:
    return ("handoff", agent_name)


def tool(name: str, **arguments) -> tuple:
    return ("tool", name, arguments)


def message(text: str) -> tuple:
    return ("message", text)


@activity.defn(name="invoke_model")
async def scripted_invoke_model(request: ModelRequest) -> ModelResponse:
    INSTRUCTIONS.append(request.system)
    kind, value, *args = SCRIPT.pop(0)
    call_id = f"call-{uuid.uuid4()}"
    offered = [t["function"]["name"] for t in request.tools]
    if kind == "handoff":
        name = Agent(value, "", "").handoff_tool_name
        assert name in offered, f"the active agent can't hand off to {value}: it offers {offered}"
        return ModelResponse(tool_calls=[ToolCall(id=call_id, name=name, arguments="{}")])
    if kind == "tool":
        assert value in offered, f"the active agent has no tool {value}: it offers {offered}"
        return ModelResponse(tool_calls=[ToolCall(id=call_id, name=value, arguments=json.dumps(args[0]))])
    return ModelResponse(content=value)


def model_worker(client: Client) -> Worker:
    """A worker that answers model calls from the script, on the model task queue."""
    return Worker(client, task_queue=TASK_QUEUE_LLM, activities=[scripted_invoke_model])


async def send(handle, prompt: str):
    """Send a customer message and return the agent's reply once it has been processed."""
    count = len(await handle.query(WealthManagementWorkflow.get_chat_history))
    await handle.signal(WealthManagementWorkflow.process_user_message, ProcessUserMessageInput(user_input=prompt))
    for _ in range(240):
        history = await handle.query(WealthManagementWorkflow.get_chat_history)
        if len(history) > count:
            return history[-1]
        await asyncio.sleep(0.25)
    raise AssertionError(f"no reply to {prompt!r}")
