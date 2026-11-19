// Package chaos is the demo's failure injection, driven by the flags in the web UI's chaos
// panel.
//
// The flags live in the Redis hash chaos:flags and are read on every activity attempt
// (including every model call), so a failure is switched on and off at runtime with no
// restart. If Redis can't be reached, every flag reads as off. Each injected failure is
// logged to the Redis list chaos:events (the last 50) for the panel to show.
//
// It is called from inside activities only, never from workflow code: reading Redis is
// non-deterministic I/O.
package chaos

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/redis/go-redis/v9"
	"go.temporal.io/sdk/activity"
)

// Flag is one failure-injection switch.
type Flag string

// The six chaos flags. Their names are shared with the other ports and the web UI.
const (
	ToolDown         Flag = "tool_down"
	LLMDown          Flag = "llm_down"
	LLMRateLimited   Flag = "llm_rate_limited"
	CustodianRejects Flag = "custodian_rejects"
	SlowSaga         Flag = "slow_saga"
	WorkflowBug      Flag = "workflow_bug"
)

// FlagInfo is a flag's display metadata for the chaos panel.
type FlagInfo struct {
	Flag        Flag
	Label       string
	Description string
}

// Flags lists every flag, in the order the panel shows them.
var Flags = []FlagInfo{
	{ToolDown, "Core banking API down",
		"Investment and beneficiary tools raise a connection error. Temporal retries until you turn this off."},
	{LLMDown, "Gemini API down",
		"Every model call raises a connection error. The agent pauses mid-turn and resumes when you turn this off."},
	{LLMRateLimited, "Gemini rate limited (429)",
		"Every model call is throttled. Retries wait for the server's Retry-After delay instead of the normal backoff."},
	{CustodianRejects, "Custodian rejects new accounts",
		"The last account-opening step fails non-retryably, so the saga rolls back the funds transfer and the account."},
	{SlowSaga, "Slow account-opening steps",
		"Each account-opening step takes a few extra seconds, so you can watch the saga (or kill the worker mid-way)."},
	{WorkflowBug, "Bug in workflow code",
		"New account openings get a welcome-bonus promo code, and the workflow's promo code path has a bug. " +
			"It pauses after compliance approval until you fix the code and restart the worker. " +
			"Turning this off does not unstick openings that already have the promo code."},
}

// IsKnown reports whether f is one of the six flags.
func IsKnown(f Flag) bool {
	for _, info := range Flags {
		if info.Flag == f {
			return true
		}
	}
	return false
}

const (
	flagsKey  = "chaos:flags"
	eventsKey = "chaos:events"
	maxEvents = 50

	// SlowSagaDelay is how long each saga step sleeps while SlowSaga is on.
	SlowSagaDelay = 4 * time.Second
)

// Event is an injected failure, as the chaos panel shows it.
type Event struct {
	Timestamp  float64 `json:"timestamp"`
	Flag       Flag    `json:"flag"`
	Source     string  `json:"source"`
	Attempt    int32   `json:"attempt"`
	WorkflowID string  `json:"workflow_id"`
}

// Source answers whether a flag is on, and records the failures it causes. The
// activities use it, so tests can swap Redis for a fake.
type Source interface {
	IsEnabled(ctx context.Context, f Flag) bool
	RecordEvent(ctx context.Context, e Event)
}

// Manager stores the flags and the failure log in Redis.
type Manager struct {
	rdb *redis.Client
}

// NewManager returns a Manager using the given Redis client.
func NewManager(rdb *redis.Client) *Manager { return &Manager{rdb: rdb} }

// IsEnabled reports whether a flag is on. It fails open: if Redis can't be reached,
// the flag is off rather than breaking the demo.
func (m *Manager) IsEnabled(ctx context.Context, f Flag) bool {
	v, err := m.rdb.HGet(ctx, flagsKey, string(f)).Result()
	if err != nil {
		if !errors.Is(err, redis.Nil) {
			slog.Warn("could not read chaos flag", "flag", f, "error", err)
		}
		return false
	}
	return v == "1"
}

// SetEnabled turns a flag on or off.
func (m *Manager) SetEnabled(ctx context.Context, f Flag, enabled bool) error {
	if enabled {
		return m.rdb.HSet(ctx, flagsKey, string(f), "1").Err()
	}
	return m.rdb.HDel(ctx, flagsKey, string(f)).Err()
}

// GetFlags returns whether each flag is on.
func (m *Manager) GetFlags(ctx context.Context) (map[Flag]bool, error) {
	all, err := m.rdb.HGetAll(ctx, flagsKey).Result()
	if err != nil {
		return nil, err
	}
	out := map[Flag]bool{}
	for _, info := range Flags {
		out[info.Flag] = all[string(info.Flag)] == "1"
	}
	return out, nil
}

// RecordEvent logs an injected failure for the chaos panel, keeping the last 50.
func (m *Manager) RecordEvent(ctx context.Context, e Event) {
	b, _ := json.Marshal(e)
	pipe := m.rdb.TxPipeline()
	pipe.LPush(ctx, eventsKey, b)
	pipe.LTrim(ctx, eventsKey, 0, maxEvents-1)
	if _, err := pipe.Exec(ctx); err != nil {
		slog.Warn("could not record chaos event", "error", err)
	}
}

// GetEvents returns the most recent injected failures, newest first.
func (m *Manager) GetEvents(ctx context.Context, limit int64) ([]Event, error) {
	raw, err := m.rdb.LRange(ctx, eventsKey, 0, limit-1).Result()
	if err != nil {
		return nil, err
	}
	events := []Event{}
	for _, s := range raw {
		var e Event
		if json.Unmarshal([]byte(s), &e) == nil {
			events = append(events, e)
		}
	}
	return events, nil
}

// ClearEvents empties the failure log.
func (m *Manager) ClearEvents(ctx context.Context) error {
	return m.rdb.Del(ctx, eventsKey).Err()
}

// Off is a Source with every flag off. The live tests use it.
type Off struct{}

func (Off) IsEnabled(context.Context, Flag) bool { return false }
func (Off) RecordEvent(context.Context, Event)   {}

// ---------------------------------------------------------------------------
// Injection helpers, for use inside activities
// ---------------------------------------------------------------------------

// Inject returns err if flag f is on, after logging the failure for the chaos panel.
// It returns nil if the flag is off. Call it from an activity.
func Inject(ctx context.Context, src Source, f Flag, err error) error {
	if !src.IsEnabled(ctx, f) {
		return nil
	}
	e := Event{Timestamp: float64(time.Now().UnixMilli()) / 1000, Flag: f}
	if activity.IsActivity(ctx) {
		info := activity.GetInfo(ctx)
		e.Source = info.ActivityType.Name
		e.Attempt = info.Attempt
		e.WorkflowID = info.WorkflowExecution.ID
		activity.GetLogger(ctx).Warn("Chaos: injecting failure", "flag", f, "attempt", info.Attempt, "error", err)
	}
	src.RecordEvent(ctx, e)
	return err
}

// ErrCoreBankingDown is the connection error the core banking API returns while it is down.
var ErrCoreBankingDown = errors.New("connection error: Core banking API unavailable")

// CoreBankingAPI fails the way the core banking API would while ToolDown is on.
func CoreBankingAPI(ctx context.Context, src Source) error {
	return Inject(ctx, src, ToolDown, ErrCoreBankingDown)
}

// MaybeSlowDown sleeps SlowSagaDelay while SlowSaga is on, simulating a slow downstream system.
func MaybeSlowDown(ctx context.Context, src Source) {
	if !src.IsEnabled(ctx, SlowSaga) {
		return
	}
	select {
	case <-time.After(SlowSagaDelay):
	case <-ctx.Done():
	}
}
