package chaos_test

import (
	"context"
	"errors"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/temporal-sa/wealth-management-demo/src/go/internal/common/chaos"
	"github.com/temporal-sa/wealth-management-demo/src/go/internal/common/session"
	"github.com/temporal-sa/wealth-management-demo/src/go/internal/common/testfixtures"
)

func newManager(t *testing.T) (*chaos.Manager, *miniredis.Miniredis) {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })
	return chaos.NewManager(rdb), mr
}

func TestKeys(t *testing.T) {
	assert.Equal(t, "chaos:abc:flags", chaos.FlagsKey("abc"))
	assert.Equal(t, "chaos:abc:events", chaos.EventsKey("abc"))
}

func TestChaosFlagsAndEventsArePerSession(t *testing.T) {
	ctx := context.Background()
	m, mr := newManager(t)
	aliceID, bobID := session.NewSessionID(), session.NewSessionID()
	alice, bob := m.ForSession(aliceID), m.ForSession(bobID)

	require.NoError(t, alice.SetEnabled(ctx, chaos.ToolDown, true))
	alice.RecordEvent(ctx, chaos.Event{Flag: chaos.ToolDown, Source: "list_investments", Attempt: 1})

	assert.True(t, alice.IsEnabled(ctx, chaos.ToolDown))
	assert.False(t, bob.IsEnabled(ctx, chaos.ToolDown))
	aliceFlags, err := alice.GetFlags(ctx)
	require.NoError(t, err)
	bobFlags, err := bob.GetFlags(ctx)
	require.NoError(t, err)
	assert.True(t, aliceFlags[chaos.ToolDown])
	assert.False(t, bobFlags[chaos.ToolDown])
	aliceEvents, err := alice.GetEvents(ctx, 20)
	require.NoError(t, err)
	bobEvents, err := bob.GetEvents(ctx, 20)
	require.NoError(t, err)
	assert.Len(t, aliceEvents, 1)
	assert.Empty(t, bobEvents)

	assert.Equal(t, "1", mr.HGet("chaos:"+aliceID+":flags", "tool_down"))
	assert.Equal(t, session.TTL, mr.TTL("chaos:"+aliceID+":flags"))
	assert.Equal(t, session.TTL, mr.TTL("chaos:"+aliceID+":events"))
	assert.False(t, mr.Exists("chaos:flags"))
	assert.False(t, mr.Exists("chaos:events"))

	require.NoError(t, alice.SetEnabled(ctx, chaos.ToolDown, false))
	assert.False(t, alice.IsEnabled(ctx, chaos.ToolDown))
	require.NoError(t, alice.ClearEvents(ctx))
	assert.False(t, mr.Exists("chaos:"+aliceID+":events"))
}

func TestEventLogKeepsTheLast50(t *testing.T) {
	ctx := context.Background()
	m, mr := newManager(t)
	for i := 0; i < 60; i++ {
		m.RecordEvent(ctx, chaos.Event{Flag: chaos.LLMDown, Attempt: int32(i)})
	}
	list, err := mr.List("chaos:default:events")
	require.NoError(t, err)
	assert.Len(t, list, 50)
	events, err := m.GetEvents(ctx, 1)
	require.NoError(t, err)
	assert.Equal(t, int32(59), events[0].Attempt)
}

func TestOutsideAnActivityChaosUsesTheDefaultSession(t *testing.T) {
	ctx := context.Background()
	m, mr := newManager(t)
	require.NoError(t, m.SetEnabled(ctx, chaos.SlowSaga, true))
	assert.Equal(t, "1", mr.HGet("chaos:default:flags", "slow_saga"))
	assert.True(t, m.IsEnabled(ctx, chaos.SlowSaga))
}

func TestAnActivityReadsAndLogsToItsOwnSession(t *testing.T) {
	ctx := context.Background()
	m, mr := newManager(t)
	aliceID, bobID := session.NewSessionID(), session.NewSessionID()
	require.NoError(t, m.ForSession(aliceID).SetEnabled(ctx, chaos.ToolDown, true))
	aliceChat := session.NewChatWorkflowID("adk-go-temporal-agent-", aliceID)
	bobChat := session.NewChatWorkflowID("adk-go-temporal-agent-", bobID)

	// An account opening of Alice's chat fails; Bob's chat doesn't.
	var aliceErr, bobErr error
	testfixtures.InActivity(t, "OpenAccount-"+aliceChat+"-123-Vacation-1", func(ctx context.Context) error {
		aliceErr = chaos.CoreBankingAPI(ctx, m)
		return nil
	})
	testfixtures.InActivity(t, bobChat, func(ctx context.Context) error {
		bobErr = chaos.CoreBankingAPI(ctx, m)
		return nil
	})
	assert.True(t, errors.Is(aliceErr, chaos.ErrCoreBankingDown))
	assert.NoError(t, bobErr)

	events, err := m.ForSession(aliceID).GetEvents(ctx, 20)
	require.NoError(t, err)
	require.Len(t, events, 1)
	assert.Equal(t, "OpenAccount-"+aliceChat+"-123-Vacation-1", events[0].WorkflowID)
	assert.Equal(t, session.TTL, mr.TTL("chaos:"+aliceID+":events"))
	assert.False(t, mr.Exists("chaos:"+bobID+":events"))
	assert.False(t, mr.Exists("chaos:default:events"))
}
