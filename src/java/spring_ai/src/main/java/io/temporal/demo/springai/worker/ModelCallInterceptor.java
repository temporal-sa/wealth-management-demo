package io.temporal.demo.springai.worker;

import io.temporal.activity.ActivityExecutionContext;
import io.temporal.common.interceptors.ActivityInboundCallsInterceptor;
import io.temporal.common.interceptors.ActivityInboundCallsInterceptorBase;
import io.temporal.common.interceptors.WorkerInterceptorBase;
import io.temporal.demo.springai.common.Chaos;
import io.temporal.failure.ApplicationFailure;
import java.time.Duration;

/**
 * Wraps the model calls: the chat model activity that Temporal's Spring AI integration registers
 * ({@value #MODEL_ACTIVITY}), which calls Gemini.
 *
 * <p>Spring AI's own retries are off (application.yaml), so Temporal alone decides when a failed call is
 * retried: an outage with the retry policy's backoff, and a 429 after 15 s, which overrides the backoff. The
 * chaos panel's "model API down" and "rate limited" switches inject those same two failures here, before Gemini
 * is called. (An interceptor rather than a wrapped ChatModel: the integration builds Gemini's own request
 * options only for the Gemini model itself.)
 */
public class ModelCallInterceptor extends WorkerInterceptorBase {
    static final String MODEL_ACTIVITY = "CallChatModel";
    static final Duration RATE_LIMIT_RETRY_AFTER = Duration.ofSeconds(15);

    private final Chaos chaos;

    public ModelCallInterceptor(Chaos chaos) {
        this.chaos = chaos;
    }

    static ApplicationFailure rateLimited(String message) {
        return ApplicationFailure.newBuilder().setMessage(message).setType("ModelRateLimited")
                .setNextRetryDelay(RATE_LIMIT_RETRY_AFTER).build();
    }

    @Override
    public ActivityInboundCallsInterceptor interceptActivity(ActivityInboundCallsInterceptor next) {
        return new ActivityInboundCallsInterceptorBase(next) {
            private ActivityExecutionContext context;

            @Override
            public void init(ActivityExecutionContext context) {
                this.context = context;
                super.init(context);
            }

            @Override
            public ActivityOutput execute(ActivityInput input) {
                if (!MODEL_ACTIVITY.equals(context.getInfo().getActivityType())) {
                    return super.execute(input);
                }
                chaos.inject(Chaos.LLM_DOWN, new IllegalStateException("Connection error: Gemini API unavailable"));
                chaos.inject(Chaos.LLM_RATE_LIMITED, rateLimited("Gemini API rate limit exceeded (HTTP 429)"));
                try {
                    return super.execute(input);
                } catch (RuntimeException e) {
                    String message = String.valueOf(e.getMessage());
                    if (message.contains("429") || message.contains("RESOURCE_EXHAUSTED")) {
                        throw rateLimited("Gemini API rate limit exceeded (HTTP 429): " + message);
                    }
                    // Anything else is retried too: a wrong key or model name won't fix itself, but the worker can
                    // be restarted with the right settings, and the turn carries on.
                    throw e;
                }
            }
        };
    }
}
