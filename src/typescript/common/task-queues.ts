// The task queue rules every framework shares. No imports and no environment access, so workflow code
// can import it too.

/**
 * The value of TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT (and the worker scripts' argument) that gives the
 * open-account workflow this framework's own queue, so the Java worker can run it.
 */
export const JAVA = 'java';

/**
 * The open-account workflow's task queue, from TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT (`value`).
 *
 * Unset or empty: the chat workflow's queue, so the framework's own worker runs it. "java":
 * `<task queue>-open-account`, a queue for this framework alone, which the Java worker started with
 * TEMPORAL_TASK_QUEUE=<task queue> polls; every framework gets its own, so several can use Java at once.
 * Anything else is the queue's name.
 */
export function openAccountTaskQueue(taskQueue: string, value: string | undefined): string {
  const setting = (value ?? '').trim();
  if (!setting) return taskQueue;
  if (setting.toLowerCase() === JAVA) return `${taskQueue}-open-account`;
  return setting;
}
