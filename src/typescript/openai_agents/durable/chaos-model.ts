/**
 * The model provider the worker's model activity uses: OpenAI, through the OpenAI Agents SDK's OpenAIProvider,
 * with the chaos panel's model flags, as in the Python OpenAI Agents framework (model_config.py).
 *
 * Temporal's OpenAI Agents integration resolves each agent's model name with this provider inside its model
 * activity (invokeModelActivity), so getResponse() runs in that activity, where the chaos flags of the chat's
 * browser session are found from the activity's workflow ID.
 *
 * The integration turns any error from the model into its own ApplicationFailure: an OpenAI APIError keeps its
 * status (a 429 or 5xx is retryable, a 400 or 401 is not) and its Retry-After header becomes the next retry
 * delay; any other error is retryable. So "LLM rate limited" throws the OpenAI SDK's own RateLimitError with a
 * Retry-After of 15 seconds, exactly what a real 429 from OpenAI looks like, and the integration sets the
 * delay. "LLM API down" throws a plain connection error, which the retry policy's backoff retries.
 */
import type { Model, ModelProvider } from '@openai/agents-core';
import { OpenAIProvider } from '@openai/agents-openai';
import OpenAI, { APIError } from 'openai';
import { ChaosFlag } from '../../common/chaos-manager';
import { injectFailure } from './chaos';

/** How long a rate-limited call waits before its retry, sent as a Retry-After header (in seconds). */
export const RATE_LIMIT_RETRY_AFTER_SECONDS = 15;

/** An OpenAI 429, as the OpenAI SDK reports one, with a Retry-After header. */
export function rateLimited(message: string): APIError {
  return APIError.generate(
    429,
    { message, type: 'rate_limit_exceeded' },
    message,
    new Headers({ 'retry-after': String(RATE_LIMIT_RETRY_AFTER_SECONDS) }),
  );
}

/** Adds the chaos panel's model flags to a model's getResponse() and getStreamedResponse(), and returns it. */
export function withChaos<M extends Model>(model: M): M {
  const getResponse = model.getResponse.bind(model);
  model.getResponse = async (request) => {
    await injectChaos();
    return getResponse(request);
  };
  const getStreamedResponse = model.getStreamedResponse.bind(model);
  model.getStreamedResponse = async function* (request) {
    await injectChaos();
    yield* getStreamedResponse(request);
  };
  return model;
}

async function injectChaos(): Promise<void> {
  await injectFailure(ChaosFlag.LLM_DOWN, new Error('ConnectionError: OpenAI API unavailable'));
  await injectFailure(ChaosFlag.LLM_RATE_LIMITED, rateLimited('OpenAI API rate limit exceeded (HTTP 429)'));
}

/**
 * Resolves model names with an inner provider and adds the chaos flags to each model. With no inner provider,
 * OpenAI with OPENAI_API_KEY from the worker's environment, and the client's own retries off, so Temporal's
 * retry policy decides how failed model calls are retried.
 */
export class ChaosModelProvider implements ModelProvider {
  constructor(private inner?: ModelProvider) {}

  async getModel(modelName?: string): Promise<Model> {
    // Built on the first call, so a worker with no key still starts (its model calls fail and retry)
    this.inner ??= new OpenAIProvider({ openAIClient: new OpenAI({ maxRetries: 0 }) });
    return withChaos(await this.inner.getModel(modelName));
  }
}
