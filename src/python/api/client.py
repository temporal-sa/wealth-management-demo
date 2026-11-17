"""How the API talks to Temporal, independent of any agent framework.

The API reaches a port's chat workflow only through the names and payloads in the
Temporal contracts, which every port shares. So it needs no workflow class or
framework plugin: it uses the contract names as strings, the Pydantic data converter
(the payloads are plain JSON, so every port's worker can read them), and the
claim-check codec when USE_CLAIM_CHECK is on. TEMPORAL_TASK_QUEUE picks the port.

Kept apart from main.py, with no FastAPI dependency, so a port's tests can check
these exact calls against its real workflow.
"""

from typing import Optional

from temporalio.client import Client
from temporalio.common import WorkflowIDReusePolicy
from temporalio.contrib.pydantic import pydantic_data_converter

from common.claim_check.claim_check_plugin import ClaimCheckPlugin
from common.user_message import ProcessUserMessageInput

# Temporal contract names for the chat workflow
CHAT_WORKFLOW = "WealthManagementWorkflow"
PROCESS_USER_MESSAGE_SIGNAL = "process_user_message"
END_WORKFLOW_SIGNAL = "end_workflow"
# Only in ports whose chat workflow pauses for approvals (Port.approvals)
PENDING_APPROVAL_QUERY = "get_pending_approval"
APPROVE_SIGNAL = "approve"
APPROVAL_RESPONSES = ("approve", "deny")


async def connect(**connect_config) -> Client:
    """Connect with the API's data converter and, if enabled, the claim-check codec."""
    return await Client.connect(
        **connect_config,
        data_converter=pydantic_data_converter,
        plugins=[ClaimCheckPlugin()],
    )


async def start_chat(client: Client, workflow_id: str, task_queue: str) -> None:
    await client.start_workflow(
        CHAT_WORKFLOW,
        id=workflow_id,
        task_queue=task_queue,
        id_reuse_policy=WorkflowIDReusePolicy.ALLOW_DUPLICATE,
    )


async def send_prompt(client: Client, workflow_id: str, prompt: str) -> ProcessUserMessageInput:
    message = ProcessUserMessageInput(user_input=prompt)
    await client.get_workflow_handle(workflow_id).signal(PROCESS_USER_MESSAGE_SIGNAL, message)
    return message


async def end_chat(client: Client, workflow_id: str) -> None:
    await client.get_workflow_handle(workflow_id).signal(END_WORKFLOW_SIGNAL)


async def pending_approval(client: Client, workflow_id: str) -> Optional[str]:
    """The approval question the chat workflow is waiting on, or None."""
    return await client.get_workflow_handle(workflow_id).query(PENDING_APPROVAL_QUERY)


async def answer_approval(client: Client, workflow_id: str, response: str) -> None:
    """Answer the pending approval: response is "approve" or "deny"."""
    if response not in APPROVAL_RESPONSES:
        raise ValueError(f"response must be one of {APPROVAL_RESPONSES}, not {response!r}")
    await client.get_workflow_handle(workflow_id).signal(APPROVE_SIGNAL, response)
