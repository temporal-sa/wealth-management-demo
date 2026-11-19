// Package session says which browser session a chat, and everything it does, belongs to.
//
// Several people can use one running copy of the demo at once. The API gives each browser a
// random session ID (a cookie) and starts its chat workflows with IDs that carry it:
//
//	<framework's workflow ID prefix>session-<32 hex chars>-chat-<16 hex chars>
//
// for example adk-go-temporal-agent-session-<session>-chat-<chat>. An open-account workflow's ID
// starts with its chat's ID (OpenAccount-<chat workflow ID>-...), so the activities of a chat and
// of its account openings can all find the session from their workflow ID. A workflow started
// some other way (a test, a script, the CLI) has no session in its ID and uses the "default"
// session.
//
// The session scopes the chaos flags (package chaos) and, with DEMO_DATA_STORE=redis, the sample
// bank data (package data). The Python and TypeScript frameworks follow the same rules
// (src/python/common/session_scope.py, src/typescript/common/session-scope.ts).
package session

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"regexp"
	"strings"
	"time"

	"go.temporal.io/sdk/activity"
)

// Default is the session of everything not started by a browser session.
const Default = "default"

// TTL is how long a session's state in Redis (chaos flags, failure log, sample data) lives after
// its last change, so abandoned sessions don't pile up.
const TTL = 24 * time.Hour

var (
	sessionIDRe         = regexp.MustCompile(`^[0-9a-f]{32}$`)
	sessionInWorkflowRe = regexp.MustCompile(`session-([0-9a-f]{32})-chat-`)
)

func randomHex(nBytes int) string {
	b := make([]byte, nBytes)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// NewSessionID returns a new random session ID: 32 lowercase hex characters.
func NewSessionID() string { return randomHex(16) }

// IsSessionID reports whether s is a well-formed session ID.
func IsSessionID(s string) bool { return sessionIDRe.MatchString(s) }

// ChatWorkflowPrefix is the start of every chat workflow ID of this session.
func ChatWorkflowPrefix(frameworkPrefix, sessionID string) string {
	return frameworkPrefix + "session-" + sessionID + "-chat-"
}

// NewChatWorkflowID returns a new chat workflow ID for this session.
func NewChatWorkflowID(frameworkPrefix, sessionID string) string {
	return ChatWorkflowPrefix(frameworkPrefix, sessionID) + randomHex(8)
}

// OwnsWorkflow reports whether workflowID is one of this session's chats.
func OwnsWorkflow(frameworkPrefix, sessionID, workflowID string) bool {
	prefix := ChatWorkflowPrefix(frameworkPrefix, sessionID)
	return strings.HasPrefix(workflowID, prefix) && len(workflowID) > len(prefix)
}

// FromWorkflowID returns the session in a chat's or account opening's workflow ID, or Default.
func FromWorkflowID(workflowID string) string {
	if m := sessionInWorkflowRe.FindStringSubmatch(workflowID); m != nil {
		return m[1]
	}
	return Default
}

// Current returns the session of the workflow whose activity ctx belongs to, or Default outside
// an activity.
func Current(ctx context.Context) string {
	if ctx == nil || !activity.IsActivity(ctx) {
		return Default
	}
	return FromWorkflowID(activity.GetInfo(ctx).WorkflowExecution.ID)
}
