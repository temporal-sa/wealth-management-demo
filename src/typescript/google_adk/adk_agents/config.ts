/**
 * Settings read from the environment. Workflow code must not read the environment, so the worker
 * reads it here and the chat workflow gets what it needs from the get_worker_config local activity.
 */
import { useClaimCheck } from '../../common/data-converter';
import { redisAddress } from '../../common/redis-config';
import { openAccountTaskQueue } from '../../common/task-queues';

/** The default Gemini model. Override it with GEMINI_MODEL. */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

/**
 * The chat workflow's task queue when TEMPORAL_TASK_QUEUE is not set: this framework's own, so its worker
 * can run alongside the other frameworks'.
 */
export const DEFAULT_TASK_QUEUE = 'ADK-TS-Supervisor';

export interface WorkerConfig {
  /** Runs the chat workflow and the tool activities (TEMPORAL_TASK_QUEUE). */
  task_queue: string;
  /** Runs OpenInvestmentAccountWorkflow (TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT: unset is task_queue, java is <task_queue>-open-account). */
  open_account_task_queue: string;
  /** Runs the model calls, so they can be rate limited on their own (TEMPORAL_TASK_QUEUE_LLM). */
  llm_task_queue: string;
  /** The Gemini model every agent uses (GEMINI_MODEL). */
  model: string;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const taskQueue = env.TEMPORAL_TASK_QUEUE || DEFAULT_TASK_QUEUE;
  return {
    task_queue: taskQueue,
    open_account_task_queue: openAccountTaskQueue(taskQueue, env.TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT),
    llm_task_queue: env.TEMPORAL_TASK_QUEUE_LLM || `${taskQueue}-llm`,
    model: env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
  };
}

/** LLM_MAX_CALLS_PER_SECOND: a cap the Temporal service puts on model calls across all workers. */
export function llmMaxCallsPerSecond(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const value = Number(env.LLM_MAX_CALLS_PER_SECOND);
  return value > 0 ? value : undefined;
}

/**
 * Whether the claim check is on, with the USE_CLAIM_CHECK value. Every program prints it at
 * startup, whatever its state, so a component left with a different setting shows at once.
 */
export function claimCheckStatus(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.USE_CLAIM_CHECK;
  const setting = value === undefined || value === '' ? 'USE_CLAIM_CHECK is not set' : `USE_CLAIM_CHECK=${value}`;
  if (useClaimCheck(value)) {
    return `Claim check: ON (${setting}; payloads stored in Redis at ${redisAddress()})`;
  }
  return `Claim check: OFF (${setting})`;
}
