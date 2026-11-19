/**
 * The workflows module (relative to this directory) for a worker on `taskQueue`. When the
 * open-account queue (from TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT, see common/task-queues.ts) is another one, the Open Account workflow runs there
 * (on the Java worker in interop/open_account/java), so the worker registers only the supervisor workflow; otherwise it
 * registers both.
 */
export function workflowsModule(taskQueue: string, openAccountQueue: string | undefined): string {
  return openAccountQueue && openAccountQueue !== taskQueue ? './workflows/supervisor-only' : './workflows/index';
}
