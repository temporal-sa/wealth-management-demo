"""The task queue rules every framework shares.

No imports beyond the standard library, so workflow code can import it through the sandbox.
"""

import os
from typing import Optional

# The value of TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT (and the worker scripts' argument) that gives the
# open-account workflow this framework's own queue, so the Java worker can run it.
JAVA = "java"


def open_account_task_queue(task_queue: str, value: Optional[str] = None) -> str:
    """The open-account workflow's task queue, from TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT.

    Unset or empty: the chat workflow's queue, so the framework's own worker runs it. "java":
    <task queue>-open-account, a queue for this framework alone, which the Java worker started with
    TEMPORAL_TASK_QUEUE=<task queue> polls; every framework gets its own, so several can use Java at
    once. Anything else is the queue's name.
    """
    if value is None:
        value = os.getenv("TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT", "")
    value = value.strip()
    if not value:
        return task_queue
    if value.lower() == JAVA:
        return f"{task_queue}-open-account"
    return value
