package standalone

import (
	"context"
	"iter"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/runner"
	"google.golang.org/adk/v2/session"
	"google.golang.org/genai"

	"go.temporal.io/googleadk"

	"github.com/temporal-sa/adk-go-wealth-management/internal/data"
	"github.com/temporal-sa/adk-go-wealth-management/internal/prompts"
)

type recordingModel struct {
	mu           sync.Mutex
	instructions []string
}

func (m *recordingModel) Name() string { return "recording" }

func (m *recordingModel) GenerateContent(_ context.Context, req *model.LLMRequest, _ bool) iter.Seq2[*model.LLMResponse, error] {
	return func(yield func(*model.LLMResponse, error) bool) {
		var b strings.Builder
		if req.Config != nil && req.Config.SystemInstruction != nil {
			for _, p := range req.Config.SystemInstruction.Parts {
				b.WriteString(p.Text)
			}
		}
		m.mu.Lock()
		m.instructions = append(m.instructions, b.String())
		m.mu.Unlock()
		yield(googleadk.TextResponse("I can only help with beneficiaries and investment accounts."), nil)
	}
}

// TestOffTopicPrompt: the standalone Supervisor Agent's prompt tells it to decline
// off-topic questions. (The Temporal version's is checked in internal/workflows.)
func TestOffTopicPrompt(t *testing.T) {
	m := &recordingModel{}
	root, err := Build(m, data.NewStore(t.TempDir()))
	require.NoError(t, err)
	r, err := runner.New(runner.Config{AppName: "test", Agent: root, SessionService: session.InMemoryService(), AutoCreateSession: true})
	require.NoError(t, err)
	for _, err := range r.Run(context.Background(), "u", "s", genai.NewContentFromText("What's the weather in Paris?", genai.RoleUser), agent.RunConfig{}) {
		require.NoError(t, err)
	}
	require.Len(t, m.instructions, 1)
	assert.Contains(t, m.instructions[0], prompts.OffTopicLine)
}
