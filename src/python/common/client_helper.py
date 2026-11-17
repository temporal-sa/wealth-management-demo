import os

from temporalio.envconfig import ClientConfig
from common.util import str_to_bool

class ClientHelper:
    def __init__(self, default_task_queue: str = "Supervisor"):
        """Temporal connection settings, from the environment configuration and these variables.

        default_task_queue is the port's chat task queue when TEMPORAL_TASK_QUEUE isn't set,
        so ports can run side by side (the Pydantic AI port uses "PY-AI-Supervisor").
        """
        self.client_config = ClientConfig.load_client_connect_config()
        # hack to stuff in a default value if it isn't set
        if self.client_config.get('target_host') is None:
            self.client_config['target_host'] = '127.0.0.1:7233'

        self.address = self.client_config.get('target_host')
        self.namespace = self.client_config.get('namespace')
        self.taskQueue = os.getenv("TEMPORAL_TASK_QUEUE", default_task_queue)
        # Task Queue for Opening a new Account. If this is not set, use the same task queue as the Supervisor
        self.taskQueueOpenAccount = os.getenv("TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT", self.taskQueue)
        # Run a worker without the agents (no chat workflow, no model calls), for the open-account
        # scenarios. SKIP_OPENAI_PLUGIN is the OpenAI Agents port's name; SKIP_AGENTS the others'.
        self.skipOpenAIPlugin = str_to_bool(os.getenv("SKIP_OPENAI_PLUGIN", "False"))
        self.skipAgents = str_to_bool(os.getenv("SKIP_AGENTS", "False"))
        # Task Queue for the model (LLM) calls, so that they can be rate limited separately from the tools
        self.taskQueueLLM = os.getenv("TEMPORAL_TASK_QUEUE_LLM", f"{self.taskQueue}-llm")
        if self.skipOpenAIPlugin:
            print("******* Skip OpenAI Plugin? True *******")
