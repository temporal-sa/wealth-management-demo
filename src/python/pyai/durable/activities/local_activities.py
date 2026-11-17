from temporalio import activity

class LocalActivities:
    """
    Local activities for configuration and lightweight operations.

    Local activities run outside the workflow sandbox and can access
    non-deterministic resources like environment variables.
    """

    @staticmethod
    @activity.defn
    async def get_task_queue_open_account() -> str:
        """Get the task queue for opening accounts from environment configuration."""
        from common.client_helper import ClientHelper
        from durable.task_queues import DEFAULT_TASK_QUEUE
        client_helper = ClientHelper(default_task_queue=DEFAULT_TASK_QUEUE)
        return client_helper.taskQueueOpenAccount
