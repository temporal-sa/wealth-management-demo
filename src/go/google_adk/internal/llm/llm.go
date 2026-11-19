// Package llm builds the real Gemini model on the worker, wrapped for the chaos panel's
// model failures, and makes rate-limited model calls wait like a Retry-After header says.
//
// The googleadk plugin runs every model call in its InvokeModel activity and builds the
// model there with a ModelFactory, so anything this package's model returns is an
// activity failure, retried by the workflow's LLM retry policy.
package llm

import (
	"context"
	"errors"
	"iter"
	"sync"
	"time"

	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/interceptor"
	"go.temporal.io/sdk/temporal"

	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/model/gemini"
	"google.golang.org/genai"

	"go.temporal.io/googleadk"

	"github.com/temporal-sa/adk-go-wealth-management/internal/chaos"
)

// RateLimitRetryAfter stands in for the Retry-After delay of a real 429.
const RateLimitRetryAfter = 15 * time.Second

// ErrorTypeRateLimited is the ApplicationError type of a rate-limited model call.
const ErrorTypeRateLimited = "ModelRateLimited"

// ErrModelDown is the connection error every model call returns while LLMDown is on.
var ErrModelDown = errors.New("connection error: Gemini API unavailable")

// RateLimitedError is a model call refused with HTTP 429.
type RateLimitedError struct{ Msg string }

func (e *RateLimitedError) Error() string { return e.Msg }

// NewGeminiFactory returns a googleadk.ModelFactory that builds the named Gemini model
// once, with the Gen AI SDK's own HTTP retries off so Temporal decides when to retry, and
// wraps it in Chaos.
func NewGeminiFactory(src chaos.Source) googleadk.ModelFactory {
	var (
		mu     sync.Mutex
		models = map[string]model.LLM{}
	)
	return func(ctx context.Context, name string) (model.LLM, error) {
		mu.Lock()
		defer mu.Unlock()
		if m, ok := models[name]; ok {
			return m, nil
		}
		one := int32(1)
		inner, err := gemini.NewModel(ctx, name, &genai.ClientConfig{
			Backend: genai.BackendGeminiAPI,
			HTTPOptions: genai.HTTPOptions{
				RetryOptions: &genai.HTTPRetryOptions{Attempts: &one},
			},
		})
		if err != nil {
			return nil, err
		}
		m := &Chaos{Inner: inner, Src: src}
		models[name] = m
		return m, nil
	}
}

// Chaos is a model.LLM that fails while the chaos panel's model flags are on.
type Chaos struct {
	Inner model.LLM
	Src   chaos.Source
}

func (c *Chaos) Name() string { return c.Inner.Name() }

func (c *Chaos) GenerateContent(ctx context.Context, req *model.LLMRequest, stream bool) iter.Seq2[*model.LLMResponse, error] {
	if err := chaos.Inject(ctx, c.Src, chaos.LLMDown, ErrModelDown); err != nil {
		return func(yield func(*model.LLMResponse, error) bool) { yield(nil, err) }
	}
	if err := chaos.Inject(ctx, c.Src, chaos.LLMRateLimited,
		&RateLimitedError{Msg: "Gemini API rate limit exceeded (HTTP 429)"}); err != nil {
		return func(yield func(*model.LLMResponse, error) bool) { yield(nil, err) }
	}
	return c.Inner.GenerateContent(ctx, req, stream)
}

// IsRateLimited reports whether a model call failed with HTTP 429, injected or real.
func IsRateLimited(err error) bool {
	var rl *RateLimitedError
	if errors.As(err, &rl) {
		return true
	}
	var apiErr genai.APIError
	if errors.As(err, &apiErr) && apiErr.Code == 429 {
		return true
	}
	var apiErrPtr *genai.APIError
	return errors.As(err, &apiErrPtr) && apiErrPtr != nil && apiErrPtr.Code == 429
}

// RateLimitInterceptor sets a rate-limited model call's next retry delay to
// RateLimitRetryAfter, overriding the retry policy's backoff, like a Retry-After header.
//
// The googleadk InvokeModel activity wraps every model error in its own ApplicationError,
// so a NextRetryDelay set inside the model would be lost. This interceptor sees the
// activity's final error and adds the delay there.
type RateLimitInterceptor struct {
	interceptor.WorkerInterceptorBase
}

func (*RateLimitInterceptor) InterceptActivity(_ context.Context, next interceptor.ActivityInboundInterceptor) interceptor.ActivityInboundInterceptor {
	return &rateLimitActivity{ActivityInboundInterceptorBase: interceptor.ActivityInboundInterceptorBase{Next: next}}
}

type rateLimitActivity struct {
	interceptor.ActivityInboundInterceptorBase
}

func (a *rateLimitActivity) ExecuteActivity(ctx context.Context, in *interceptor.ExecuteActivityInput) (any, error) {
	result, err := a.Next.ExecuteActivity(ctx, in)
	if err != nil && activity.GetInfo(ctx).ActivityType.Name == googleadk.InvokeModelActivityName && IsRateLimited(err) {
		return nil, RetryAfter(err)
	}
	return result, err
}

// RetryAfter wraps a rate-limited model error so its next retry waits RateLimitRetryAfter.
func RetryAfter(err error) error {
	return temporal.NewApplicationErrorWithOptions(err.Error(), ErrorTypeRateLimited, temporal.ApplicationErrorOptions{
		NextRetryDelay: RateLimitRetryAfter,
		Cause:          err,
	})
}
