"""Task queue names, read from the environment when first imported.

Kept apart from ClientHelper, which reads Temporal's config files, so that workflow
code can import it (passed through the sandbox): every worker must run with the same
values.
"""

import os

# This port's default chat task queue, used when TEMPORAL_TASK_QUEUE isn't set. Each port
# has its own default so their workers can run against the same Temporal service at once.
# Start the shared API with ./startlocalapi.sh pure and the Java worker with
# TEMPORAL_TASK_QUEUE=Pure-Supervisor to use this port.
DEFAULT_TASK_QUEUE = "Pure-Supervisor"

# The chat workflow, its tools, and by default the open-account workflow.
TASK_QUEUE = os.getenv("TEMPORAL_TASK_QUEUE", DEFAULT_TASK_QUEUE)
# The open-account child workflow. Set it to run that workflow on another worker (such as the Java one).
TASK_QUEUE_OPEN_ACCOUNT = os.getenv("TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT", TASK_QUEUE)
# Model (LLM) calls, so they can be rate limited separately from the tools (LLM_MAX_CALLS_PER_SECOND).
TASK_QUEUE_LLM = os.getenv("TEMPORAL_TASK_QUEUE_LLM", f"{TASK_QUEUE}-llm")
