"""This framework's default chat task queue.

Used when TEMPORAL_TASK_QUEUE isn't set. Each framework has its own default so their workers can
run against the same Temporal service at once. Start the shared API with
./startlocalapi.sh openai_agents and the Java worker with TEMPORAL_TASK_QUEUE=OAI-Supervisor
to use this framework.
"""

DEFAULT_TASK_QUEUE = "OAI-Supervisor"
