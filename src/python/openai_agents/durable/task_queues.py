"""This port's default chat task queue.

Used when TEMPORAL_TASK_QUEUE isn't set. Each port has its own default so their workers can
run against the same Temporal service at once. Start the shared API with
./startlocalapi.sh openai_agents and the Java worker with TEMPORAL_TASK_QUEUE=OAI-Supervisor
to use this port.
"""

DEFAULT_TASK_QUEUE = "OAI-Supervisor"
