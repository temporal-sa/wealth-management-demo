import { ClientHelper } from '../../common/client-helper';

// This port's chat task queue when TEMPORAL_TASK_QUEUE isn't set, so it can run alongside the
// other ports. Model calls default to "<task queue>-llm" (see ClientHelper.taskQueueLLM).
export const DEFAULT_TASK_QUEUE = 'VAI-Supervisor';

/** Connection settings and task queues for this port, read from the environment. */
export function clientHelper(): ClientHelper {
  return new ClientHelper(DEFAULT_TASK_QUEUE);
}
