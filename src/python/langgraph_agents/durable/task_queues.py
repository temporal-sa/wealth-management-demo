"""Task queue names, read from the environment when first imported.

Kept apart from ClientHelper, which reads Temporal's config files, so that workflow
code can import it (passed through the sandbox): every worker must run with the same
values.
"""

import os

from common.task_queues import open_account_task_queue

# This framework's default chat task queue, used when TEMPORAL_TASK_QUEUE isn't set. Each framework
# has its own default so their workers can run against the same Temporal service at once.
# Start the shared API with ./startlocalapi.sh langgraph_agents and the Java worker with
# TEMPORAL_TASK_QUEUE=LangGraph-Supervisor to use this framework.
DEFAULT_TASK_QUEUE = "LangGraph-Supervisor"

# The chat workflow, its tools, and by default the open-account workflow.
TASK_QUEUE = os.getenv("TEMPORAL_TASK_QUEUE", DEFAULT_TASK_QUEUE)
# The open-account child workflow. TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT=java gives it this framework's
# <task queue>-open-account, so the Java worker runs it.
TASK_QUEUE_OPEN_ACCOUNT = open_account_task_queue(TASK_QUEUE)
# Model (LLM) calls, so they can be rate limited separately from the tools (LLM_MAX_CALLS_PER_SECOND).
TASK_QUEUE_LLM = os.getenv("TEMPORAL_TASK_QUEUE_LLM", f"{TASK_QUEUE}-llm")
