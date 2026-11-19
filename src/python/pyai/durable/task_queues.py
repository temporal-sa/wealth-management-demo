"""This port's default chat task queue, used when TEMPORAL_TASK_QUEUE isn't set.

Each port has its own default so that their workers can run against the same Temporal
service at once. Start the shared API and the Java worker with
TEMPORAL_TASK_QUEUE=PYAI-Supervisor to use this port.
"""

DEFAULT_TASK_QUEUE = "PYAI-Supervisor"
