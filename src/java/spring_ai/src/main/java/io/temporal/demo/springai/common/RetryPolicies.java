package io.temporal.demo.springai.common;

import io.temporal.common.RetryOptions;
import java.time.Duration;

/**
 * The retry policies, the same as the other frameworks'. Both retry indefinitely: an outage pauses the agent
 * instead of failing the conversation, and it carries on as soon as the dependency recovers. Errors raised as
 * non-retryable (business rules) still fail at once. Pair them with a start-to-close timeout (one attempt).
 */
public final class RetryPolicies {
    /** Tool and business-system activities. */
    public static final RetryOptions TOOL = RetryOptions.newBuilder()
            .setInitialInterval(Duration.ofSeconds(1)).setBackoffCoefficient(2)
            .setMaximumInterval(Duration.ofSeconds(5)).build();
    /** Model calls. A rate-limited call overrides this backoff with its own next retry delay. */
    public static final RetryOptions LLM = RetryOptions.newBuilder()
            .setInitialInterval(Duration.ofSeconds(1)).setBackoffCoefficient(2)
            .setMaximumInterval(Duration.ofSeconds(10)).build();

    private RetryPolicies() {
    }
}
