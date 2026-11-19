"""How the API talks to Temporal, independent of any agent framework.

The API reaches a framework's chat workflow only through the names and payloads in the
Temporal contracts, which every framework shares. So it needs no workflow class or
framework plugin: it uses the contract names as strings, the Pydantic data converter
(the payloads are plain JSON, so every framework's worker can read them), and the
claim-check codec when USE_CLAIM_CHECK is on. TEMPORAL_TASK_QUEUE picks the AI framework's workers.

Kept apart from main.py, with no FastAPI dependency, so a framework's tests can check
these exact calls against its real workflow.
"""

from temporalio.client import Client
from temporalio.common import WorkflowIDReusePolicy
from temporalio.contrib.pydantic import pydantic_data_converter

from common.claim_check.claim_check_plugin import ClaimCheckPlugin
from common.user_message import ProcessUserMessageInput

# Temporal contract names for the chat workflow
CHAT_WORKFLOW = "WealthManagementWorkflow"
PROCESS_USER_MESSAGE_SIGNAL = "process_user_message"
END_WORKFLOW_SIGNAL = "end_workflow"

# Temporal contract names for the open-account workflow, which every framework (and the Java
# worker) starts as a child of the chat with an ID beginning OpenAccount-<chat workflow ID>-
OPEN_ACCOUNT_ID_PREFIX = "OpenAccount-"
OPEN_ACCOUNT_STATE_QUERY = "get_current_state"
COMPLIANCE_APPROVED_SIGNAL = "compliance_approved"
WAITING_COMPLIANCE_REVIEW = "Waiting Compliance Review"


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


async def approve_compliance(client: Client, chat_workflow_id: str) -> list[str]:
    """Approves the compliance review of the chat's account openings that wait for it.

    Finds the chat's running open-account workflows by ID, asks each for its state and sends
    compliance_approved to those waiting for compliance review. Returns their workflow IDs.
    """
    if "'" in chat_workflow_id or "\\" in chat_workflow_id:
        raise ValueError("A chat workflow ID can't contain quotes or backslashes")
    query = (f"WorkflowId STARTS_WITH '{OPEN_ACCOUNT_ID_PREFIX}{chat_workflow_id}-' "
             "AND ExecutionStatus = 'Running'")
    approved = []
    async for execution in client.list_workflows(query):
        handle = client.get_workflow_handle(execution.id, run_id=execution.run_id)
        if await handle.query(OPEN_ACCOUNT_STATE_QUERY, result_type=str) == WAITING_COMPLIANCE_REVIEW:
            await handle.signal(COMPLIANCE_APPROVED_SIGNAL)
            approved.append(execution.id)
    return approved
