/**
 * The model the worker's model activity calls: Gemini, wrapped so the chaos panel's model flags fail
 * calls the way a real outage or rate limit would.
 *
 * Temporal's Google ADK integration runs every model call in its adk-invokeModel activity and builds
 * the model there with the plugin's modelProvider. It turns the Gen AI SDK's own HTTP retries off,
 * so Temporal decides when to retry. An ApplicationFailure thrown here reaches Temporal unchanged,
 * so a rate-limited call's next retry delay is kept (the Go integration drops it, and the Go framework
 * needs an interceptor; this one doesn't).
 */
import { BaseLlm, LLMRegistry, type BaseLlmConnection, type LlmRequest, type LlmResponse } from '@google/adk';
import { ApplicationFailure } from '@temporalio/common';
import { ChaosFlag } from '../../common/chaos-manager';
import { injectFailure } from './chaos';

/** How long a rate-limited call waits before its retry, like a Retry-After header. */
export const RATE_LIMIT_RETRY_AFTER = '15s';
export const RATE_LIMITED_ERROR_TYPE = 'ModelRateLimited';

export function rateLimited(message: string): ApplicationFailure {
  return ApplicationFailure.create({ message, type: RATE_LIMITED_ERROR_TYPE, nextRetryDelay: RATE_LIMIT_RETRY_AFTER });
}

/** Fails model calls while the chaos panel's model flags are on, then calls the real model. */
export class ChaosLlm extends BaseLlm {
  constructor(private readonly inner: BaseLlm) {
    super({ model: inner.model });
  }

  override async *generateContentAsync(
    request: LlmRequest,
    stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    await injectFailure(ChaosFlag.LLM_DOWN, new Error('ConnectionError: Gemini API unavailable'));
    await injectFailure(ChaosFlag.LLM_RATE_LIMITED, rateLimited('Gemini API rate limit exceeded (HTTP 429)'));
    yield* this.inner.generateContentAsync(request, stream, abortSignal);
  }

  override async connect(request: LlmRequest): Promise<BaseLlmConnection> {
    return this.inner.connect(request);
  }
}

/**
 * The plugin's modelProvider: the named model from ADK's registry (Gemini, with GEMINI_API_KEY or
 * GOOGLE_GENAI_API_KEY from the worker's environment), wrapped in ChaosLlm. Tests pass their own
 * scripted model as `inner`.
 */
export function chaosModelProvider(inner: (model: string) => BaseLlm = (m) => LLMRegistry.newLlm(m)) {
  return (model: string): BaseLlm => new ChaosLlm(inner(model));
}
