import { getSharedClient } from '../../../common/client-helper';
import { clientHelper } from '../task-queues';
import { openAccountTaskQueue } from '../../../common/task-queues';
import { WealthManagementClient } from '../../../common/shared';

/**
 * The current client details from the OpenInvestmentAccountWorkflow child workflow. It is an update,
 * so it waits until the workflow has loaded them.
 */
export async function get_current_client_info(workflowId: string): Promise<WealthManagementClient | null> {
  const client = await getSharedClient();
  const handle = client.workflow.getHandle(workflowId);
  return handle.executeUpdate<WealthManagementClient | null, []>('get_client_details');
}

/** Approves KYC: sends the child workflow's verify_kyc signal. */
export async function approve_kyc(workflowId: string): Promise<void> {
  const client = await getSharedClient();
  await client.workflow.getHandle(workflowId).signal('verify_kyc');
}

/**
 * Saves corrected client details through the child workflow, which also approves KYC. Returns the
 * child's result message.
 */
export async function update_client_details(
  workflowId: string,
  fields: Partial<WealthManagementClient>,
): Promise<string> {
  const client = await getSharedClient();
  const handle = client.workflow.getHandle(workflowId);
  return handle.executeUpdate<string, [Partial<WealthManagementClient>]>('update_client_details', {
    args: [fields],
  });
}

/**
 * The task queue for the OpenInvestmentAccountWorkflow child workflow, or null to run it on this
 * worker's task queue. TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT=java runs it on this port's
 * <task queue>-open-account, for the Java worker in interop/open_account/java (see
 * common/task-queues.ts). Workflow code can't read the environment, so it asks this activity.
 * Not part of the shared Temporal contract.
 */
export async function get_open_account_task_queue(): Promise<string | null> {
  const taskQueue = clientHelper().taskQueue;
  const openAccountQueue = openAccountTaskQueue(taskQueue, process.env.TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT);
  return openAccountQueue === taskQueue ? null : openAccountQueue;
}

/**
 * The task queue for model (LLM) calls: TEMPORAL_TASK_QUEUE_LLM, or "<TEMPORAL_TASK_QUEUE>-llm".
 * Workflow code can't read the environment, so it asks this activity. Not part of the shared
 * Temporal contract.
 */
export async function get_llm_task_queue(): Promise<string> {
  return clientHelper().taskQueueLLM;
}
