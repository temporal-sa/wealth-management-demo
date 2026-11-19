package workflows

import (
	"time"

	"go.temporal.io/sdk/temporal"
)

// Both retry policies retry indefinitely: a downstream outage pauses the agent instead
// of failing the conversation, and it carries on as soon as the dependency recovers. The
// maximum interval is kept short so recovery shows within seconds during a demo.
// Non-retryable errors (business-rule failures) still fail at once.
//
// Pair them with a StartToCloseTimeout (one attempt), never a ScheduleToCloseTimeout
// (all attempts), or an outage times out instead of being waited out.

// ToolRetryPolicy is for tool and business-system activities.
var ToolRetryPolicy = &temporal.RetryPolicy{
	InitialInterval:    time.Second,
	BackoffCoefficient: 2,
	MaximumInterval:    5 * time.Second,
}

// LLMRetryPolicy is for model calls. A rate-limited call overrides this backoff with the
// server's Retry-After delay (see internal/llm).
var LLMRetryPolicy = &temporal.RetryPolicy{
	InitialInterval:    time.Second,
	BackoffCoefficient: 2,
	MaximumInterval:    10 * time.Second,
}

// ToolTimeout bounds one attempt of a tool activity.
const ToolTimeout = 30 * time.Second

// ModelTimeout bounds one attempt of a model call.
const ModelTimeout = 2 * time.Minute
