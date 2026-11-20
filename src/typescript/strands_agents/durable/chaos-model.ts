/**
 * The model the worker's model activity calls: Gemini, through the Strands SDK's GoogleModel, with the chaos
 * panel's model flags.
 *
 * Temporal's Strands integration builds the model on the worker with the plugin's `models` factory and runs
 * every model call in its model activity, so `stream()` runs inside that activity, where the chaos flags of the
 * chat's browser session are found from the activity's workflow ID. While "LLM API down" or "LLM rate limited"
 * is on, the call fails the way a real outage or 429 would; a real 429 from Gemini (Strands'
 * ModelThrottledError) gets the same 15-second retry delay. An ApplicationFailure thrown here reaches Temporal
 * unchanged, so the next retry delay is kept.
 *
 * The flags are added to the model instance's `stream()` rather than by wrapping the model in another class, so
 * the plugin still sees the real model (its id, config and context window).
 */
import { ModelThrottledError, type Model } from '@strands-agents/sdk';
import { GoogleModel } from '@strands-agents/sdk/models/google';
import { ApplicationFailure } from '@temporalio/common';
import { ChaosFlag } from '../../common/chaos-manager';
import { injectFailure } from './chaos';

/** How long a rate-limited call waits before its retry, like a Retry-After header. */
export const RATE_LIMIT_RETRY_AFTER = '15s';
export const RATE_LIMITED_ERROR_TYPE = 'ModelRateLimited';

export function rateLimited(message: string): ApplicationFailure {
  return ApplicationFailure.create({ message, type: RATE_LIMITED_ERROR_TYPE, nextRetryDelay: RATE_LIMIT_RETRY_AFTER });
}

/** Adds the chaos panel's model flags to a model's stream(), and returns the same model. */
export function withChaos<M extends Model>(model: M): M {
  const stream = model.stream.bind(model);
  model.stream = async function* (messages, options) {
    await injectFailure(ChaosFlag.LLM_DOWN, new Error('ConnectionError: Gemini API unavailable'));
    await injectFailure(ChaosFlag.LLM_RATE_LIMITED, rateLimited('Gemini API rate limit exceeded (HTTP 429)'));
    try {
      yield* stream(messages, options);
    } catch (err) {
      if (err instanceof ModelThrottledError) {
        throw rateLimited(`Gemini API rate limit exceeded (HTTP 429): ${err.message}`);
      }
      throw err;
    }
  } as M['stream'];
  return model;
}

/** Gemini, with GEMINI_API_KEY (or GOOGLE_API_KEY) from the worker's environment. */
export function geminiModel(modelId: string): GoogleModel {
  return new GoogleModel({ modelId, apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY });
}
