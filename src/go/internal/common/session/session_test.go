package session_test

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"

	"github.com/temporal-sa/wealth-management-demo/src/go/internal/common/session"
	"github.com/temporal-sa/wealth-management-demo/src/go/internal/common/testfixtures"
)

const prefix = "adk-go-temporal-agent-"

func TestSessionIDs(t *testing.T) {
	id := session.NewSessionID()
	assert.Len(t, id, 32)
	assert.True(t, session.IsSessionID(id))
	assert.NotEqual(t, id, session.NewSessionID())
	for _, bad := range []string{"", session.Default, "ABCDEF0123456789ABCDEF0123456789", id[:31], id + "0", id + "\n"} {
		assert.False(t, session.IsSessionID(bad), bad)
	}
	assert.Equal(t, "default", session.Default)
	assert.Equal(t, 24*time.Hour, session.TTL)
}

func TestChatWorkflowIDsCarryTheSession(t *testing.T) {
	id := session.NewSessionID()
	chat := session.NewChatWorkflowID(prefix, id)
	assert.Regexp(t, `^adk-go-temporal-agent-session-`+id+`-chat-[0-9a-f]{16}$`, chat)
	assert.Equal(t, prefix+"session-"+id+"-chat-", session.ChatWorkflowPrefix(prefix, id))
	assert.True(t, session.OwnsWorkflow(prefix, id, chat))
	assert.False(t, session.OwnsWorkflow(prefix, session.NewSessionID(), chat))
	assert.False(t, session.OwnsWorkflow(prefix, id, session.ChatWorkflowPrefix(prefix, id)))
	assert.False(t, session.OwnsWorkflow(prefix, id, "oai-temporal-agent-k3j9x2m1q8"))
	assert.False(t, session.OwnsWorkflow("oai-temporal-agent-", id, chat))
}

func TestTheSessionComesFromAChatOrAccountOpeningID(t *testing.T) {
	id := session.NewSessionID()
	chat := session.NewChatWorkflowID(prefix, id)
	assert.Equal(t, id, session.FromWorkflowID(chat))
	assert.Equal(t, id, session.FromWorkflowID("OpenAccount-"+chat+"-123-Vacation account-1"))
	for _, other := range []string{"", "adk-go-temporal-agent-k3j9x2m1q8", "bug-test-1",
		prefix + "session-" + id[:31] + "-chat-0123", prefix + "session-" + id + "-0123"} {
		assert.Equal(t, session.Default, session.FromWorkflowID(other), other)
	}
}

func TestAnActivityFindsItsSessionFromItsWorkflowID(t *testing.T) {
	id := session.NewSessionID()
	chat := session.NewChatWorkflowID(prefix, id)
	for wfID, want := range map[string]string{
		chat: id,
		"OpenAccount-" + chat + "-123-Vacation-1": id,
		"OpenAccount-test-chat-123-Vacation-1":    session.Default,
	} {
		var got string
		testfixtures.InActivity(t, wfID, func(ctx context.Context) error {
			got = session.Current(ctx)
			return nil
		})
		assert.Equal(t, want, got, wfID)
	}
	assert.Equal(t, session.Default, session.Current(context.Background()))
}
