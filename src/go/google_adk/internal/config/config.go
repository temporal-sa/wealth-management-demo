// Package config reads the demo's settings from the environment, once, at process start.
//
// Workflow code must not read the environment itself, so the worker reads it here and
// hands the values to the workflows when it registers them.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"

	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/contrib/envconfig"

	"github.com/temporal-sa/adk-go-wealth-management/internal/claimcheck"
	"github.com/temporal-sa/adk-go-wealth-management/internal/redisx"
)

// DefaultGeminiModel matches the Python ADK port's default.
const DefaultGeminiModel = "gemini-3.8-flash"

// Config holds the task queues, the model and the Temporal connection settings.
type Config struct {
	// TaskQueue runs the chat workflow and the tool activities (TEMPORAL_TASK_QUEUE).
	TaskQueue string
	// TaskQueueOpenAccount runs OpenInvestmentAccountWorkflow (TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT).
	// It defaults to TaskQueue; set it to run the workflow on another worker.
	TaskQueueOpenAccount string
	// TaskQueueLLM runs the model calls, so they can be rate limited on their own
	// (TEMPORAL_TASK_QUEUE_LLM, default <TaskQueue>-llm).
	TaskQueueLLM string
	// GeminiModel is the Gemini model every agent uses (GEMINI_MODEL).
	GeminiModel string
	// LLMMaxCallsPerSecond, when above zero, has the Temporal service limit the rate of
	// model calls across all workers (LLM_MAX_CALLS_PER_SECOND).
	LLMMaxCallsPerSecond float64
}

// Load reads the configuration from the environment.
func Load() Config {
	taskQueue := getenv("TEMPORAL_TASK_QUEUE", "Supervisor")
	c := Config{
		TaskQueue:            taskQueue,
		TaskQueueOpenAccount: getenv("TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT", taskQueue),
		TaskQueueLLM:         getenv("TEMPORAL_TASK_QUEUE_LLM", taskQueue+"-llm"),
		GeminiModel:          getenv("GEMINI_MODEL", DefaultGeminiModel),
	}
	if v := os.Getenv("LLM_MAX_CALLS_PER_SECOND"); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			c.LLMMaxCallsPerSecond = f
		}
	}
	return c
}

// ClientOptions returns the Temporal client options from the environment (TEMPORAL_ADDRESS,
// TEMPORAL_NAMESPACE, TLS settings, or a temporal.toml profile), defaulting to a local
// development server at 127.0.0.1:7233. With USE_CLAIM_CHECK on, payloads go through the
// claim-check codec, stored in Redis.
func ClientOptions() (client.Options, error) {
	opts, err := envconfig.LoadDefaultClientOptions()
	if err != nil {
		return client.Options{}, err
	}
	if opts.HostPort == "" {
		opts.HostPort = "127.0.0.1:7233"
	}
	if UseClaimCheck() {
		opts.DataConverter = claimcheck.DataConverter(redisx.NewClient())
	}
	return opts, nil
}

// ClaimCheckStatus describes whether the claim-check codec is on, for every program to
// print at startup, whatever USE_CLAIM_CHECK says.
func ClaimCheckStatus() string {
	v := os.Getenv("USE_CLAIM_CHECK")
	setting := "USE_CLAIM_CHECK is not set"
	if v != "" {
		setting = "USE_CLAIM_CHECK=" + v
	}
	if UseClaimCheck() {
		return fmt.Sprintf("Claim check: ON (%s; payloads stored in Redis at %s)", setting, redisx.Addr())
	}
	return fmt.Sprintf("Claim check: OFF (%s)", setting)
}

// UseClaimCheck reports whether the claim-check codec is on (USE_CLAIM_CHECK is true, yes or 1).
func UseClaimCheck() bool { return Bool("USE_CLAIM_CHECK") }

// Bool reports whether an environment variable is set to true, yes or 1.
func Bool(name string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(name))) {
	case "true", "t", "yes", "y", "1":
		return true
	}
	return false
}

func getenv(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}
