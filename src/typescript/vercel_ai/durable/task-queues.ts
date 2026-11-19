import { ClientHelper } from '../../common/client-helper';

// This framework's chat task queue when TEMPORAL_TASK_QUEUE isn't set, so it can run alongside the
// other frameworks. Model calls default to "<task queue>-llm" (see ClientHelper.taskQueueLLM).
export const DEFAULT_TASK_QUEUE = 'VAI-Supervisor';

/** Connection settings and task queues for this framework, read from the environment. */
export function clientHelper(): ClientHelper {
  return new ClientHelper(DEFAULT_TASK_QUEUE);
}
