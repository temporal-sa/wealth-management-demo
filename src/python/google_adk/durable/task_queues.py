"""Task queue names, read once from the environment (see ClientHelper).

Workflow code must not read the environment, so workflow modules import these
constants through workflow.unsafe.imports_passed_through(), which runs this module
once, outside the sandbox.
"""

from common.client_helper import ClientHelper

# This port's default chat task queue, used when TEMPORAL_TASK_QUEUE isn't set. Each port
# has its own default so that their workers can run against the same Temporal service at
# once. Start the shared API with ./startlocalapi.sh google_adk and the Java worker with
# TEMPORAL_TASK_QUEUE=ADK-Supervisor to use this port.
DEFAULT_TASK_QUEUE = "ADK-Supervisor"

_client_helper = ClientHelper(default_task_queue=DEFAULT_TASK_QUEUE)

# The Open Account workflow can run on its own task queue, e.g. in the Java worker
# (see setsplitworkflows.sh).
OPEN_ACCOUNT_TASK_QUEUE = _client_helper.taskQueueOpenAccount
# Model calls run on their own task queue, so they can be rate limited separately from the tools.
LLM_TASK_QUEUE = _client_helper.taskQueueLLM
