// Package eventstream is the per-chat Redis event stream the web front end polls.
//
// Each chat has a Redis list, events:<chat workflow ID>, of JSON events {type, content}:
// a chat_interaction after each turn and a status_update for each account-opening state
// change.
package eventstream

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/temporal-sa/adk-go-wealth-management/internal/domain"
)

// TTL is how long a chat's events are kept after its last event, so abandoned chats don't
// pile up in Redis.
const TTL = 24 * time.Hour

// Stream appends to and reads a chat's events. The live tests swap Redis for Memory.
type Stream interface {
	Append(ctx context.Context, workflowID string, e domain.Event) (int64, error)
	EventsFrom(ctx context.Context, workflowID string, fromIndex int64) ([]json.RawMessage, error)
	Delete(ctx context.Context, workflowID string) (bool, error)
}

func streamKey(workflowID string) string { return "events:" + workflowID }
func metaKey(workflowID string) string   { return "events:" + workflowID + ":meta" }

// Redis is a Stream stored in Redis.
type Redis struct {
	rdb *redis.Client
}

// NewRedis returns a Stream stored in Redis.
func NewRedis(rdb *redis.Client) *Redis { return &Redis{rdb: rdb} }

// Append adds an event to a chat's stream and returns the stream's new length.
func (r *Redis) Append(ctx context.Context, workflowID string, e domain.Event) (int64, error) {
	b, err := json.Marshal(e)
	if err != nil {
		return 0, err
	}
	n, err := r.rdb.RPush(ctx, streamKey(workflowID), b).Result()
	if err != nil {
		return 0, err
	}
	return n, r.rdb.Expire(ctx, streamKey(workflowID), TTL).Err()
}

// EventsFrom returns a chat's events, starting at an index.
func (r *Redis) EventsFrom(ctx context.Context, workflowID string, fromIndex int64) ([]json.RawMessage, error) {
	raw, err := r.rdb.LRange(ctx, streamKey(workflowID), fromIndex, -1).Result()
	if err != nil {
		return nil, err
	}
	out := []json.RawMessage{}
	for _, s := range raw {
		if json.Valid([]byte(s)) {
			out = append(out, json.RawMessage(s))
		}
	}
	return out, nil
}

// Delete removes a chat's stream. It reports whether there was one.
func (r *Redis) Delete(ctx context.Context, workflowID string) (bool, error) {
	n, err := r.rdb.Del(ctx, streamKey(workflowID), metaKey(workflowID)).Result()
	return n > 0, err
}

// Memory is a Stream kept in memory, used by the live tests in place of Redis.
type Memory struct {
	mu     sync.Mutex
	events map[string][]json.RawMessage
}

// NewMemory returns an empty in-memory Stream.
func NewMemory() *Memory { return &Memory{events: map[string][]json.RawMessage{}} }

func (m *Memory) Append(_ context.Context, workflowID string, e domain.Event) (int64, error) {
	b, err := json.Marshal(e)
	if err != nil {
		return 0, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.events[workflowID] = append(m.events[workflowID], b)
	return int64(len(m.events[workflowID])), nil
}

func (m *Memory) EventsFrom(_ context.Context, workflowID string, fromIndex int64) ([]json.RawMessage, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	all := m.events[workflowID]
	if fromIndex >= int64(len(all)) {
		return []json.RawMessage{}, nil
	}
	return append([]json.RawMessage{}, all[fromIndex:]...), nil
}

func (m *Memory) Delete(_ context.Context, workflowID string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.events[workflowID]
	delete(m.events, workflowID)
	return ok, nil
}
