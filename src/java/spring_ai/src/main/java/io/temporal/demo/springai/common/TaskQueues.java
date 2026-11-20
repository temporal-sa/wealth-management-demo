package io.temporal.demo.springai.common;

/**
 * This framework's task queues, read from the environment, with the rule every framework shares for the
 * open-account workflow's queue (src/python/common/task_queues.py).
 */
public final class TaskQueues {
    /** This framework's default chat task queue, used when TEMPORAL_TASK_QUEUE isn't set. */
    public static final String DEFAULT_TASK_QUEUE = "SpringAI-Supervisor";

    private TaskQueues() {
    }

    /** The chat workflow, its tools and, by default, the open-account workflow. */
    public static String chat() {
        return env("TEMPORAL_TASK_QUEUE", DEFAULT_TASK_QUEUE);
    }

    /** The model calls (the agents' chat model activity), so they can be rate limited apart from the tools. */
    public static String llm() {
        return env("TEMPORAL_TASK_QUEUE_LLM", chat() + "-llm");
    }

    /** The open-account workflow's queue: TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT, or the chat queue. */
    public static String openAccount() {
        return openAccount(chat(), System.getenv("TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT"));
    }

    /**
     * Unset or empty: the chat queue, so this worker runs the open-account workflow. "java": {@code
     * <task queue>-open-account}, which the Java worker started with TEMPORAL_TASK_QUEUE=<task queue> polls.
     * Anything else is the queue's name.
     */
    public static String openAccount(String taskQueue, String value) {
        if (value == null || value.isBlank()) {
            return taskQueue;
        }
        if (value.trim().equalsIgnoreCase("java")) {
            return taskQueue + "-open-account";
        }
        return value.trim();
    }

    static String env(String name, String defaultValue) {
        String value = System.getenv(name);
        return value != null && !value.isBlank() ? value.trim() : defaultValue;
    }
}
