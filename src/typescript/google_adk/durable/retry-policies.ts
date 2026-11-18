import type { RetryPolicy } from '@temporalio/common';

// Both policies retry with no attempt limit: an outage pauses the agent instead of failing the
// conversation, and it carries on as soon as the dependency recovers. The maximum interval is short
// so recovery shows within seconds in a demo. Non-retryable (business) failures still fail at once.
//
// Pair them with a start-to-close timeout (one attempt), never schedule-to-close (all attempts), or
// an outage times out instead of being waited out.

/** Tool and business-system activities. */
export const TOOL_RETRY_POLICY: RetryPolicy = {
  initialInterval: '1s',
  backoffCoefficient: 2,
  maximumInterval: '5s',
};

/** Model calls. A rate-limited call overrides this backoff with its Retry-After delay (see chaos-model.ts). */
export const LLM_RETRY_POLICY: RetryPolicy = {
  initialInterval: '1s',
  backoffCoefficient: 2,
  maximumInterval: '10s',
};

/** One attempt of a tool activity. */
export const TOOL_TIMEOUT = '30s';

/** One attempt of a model call. */
export const MODEL_TIMEOUT = '2 minutes';
