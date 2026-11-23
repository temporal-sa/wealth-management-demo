/**
 * The workflows module for the worker: both workflows, or only the chat workflow when the
 * open-account workflow runs on another task queue (TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT, the Java worker).
 */
export function workflowsModule(registerOpenAccount: boolean): string {
  return registerOpenAccount ? './workflows/index' : './workflows/supervisor-only';
}
