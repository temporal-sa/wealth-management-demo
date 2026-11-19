package workflows

import (
	"context"
	"iter"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/testsuite"
	"go.temporal.io/sdk/workflow"

	"google.golang.org/adk/v2/model"

	"go.temporal.io/googleadk"

	"github.com/temporal-sa/adk-go-wealth-management/internal/activities"
	"github.com/temporal-sa/adk-go-wealth-management/internal/chaos"
	"github.com/temporal-sa/adk-go-wealth-management/internal/data"
	"github.com/temporal-sa/adk-go-wealth-management/internal/domain"
	"github.com/temporal-sa/adk-go-wealth-management/internal/eventstream"
	"github.com/temporal-sa/adk-go-wealth-management/internal/testfixtures"
)

const testModel = "scripted-model"

// scriptedModel answers model calls from a script, in order, and records each request.
type scriptedModel struct {
	mu        sync.Mutex
	responses []*model.LLMResponse
	next      int
	requests  []*model.LLMRequest
}

func newScriptedModel(responses ...*model.LLMResponse) *scriptedModel {
	return &scriptedModel{responses: responses}
}

func (m *scriptedModel) Name() string { return testModel }

func (m *scriptedModel) GenerateContent(_ context.Context, req *model.LLMRequest, _ bool) iter.Seq2[*model.LLMResponse, error] {
	return func(yield func(*model.LLMResponse, error) bool) {
		m.mu.Lock()
		m.requests = append(m.requests, req)
		resp := googleadk.TextResponse("(script finished)")
		if m.next < len(m.responses) {
			resp = m.responses[m.next]
			m.next++
		}
		m.mu.Unlock()
		yield(resp, nil)
	}
}

// systemInstructions returns the system instruction of each recorded request.
func (m *scriptedModel) systemInstructions() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []string
	for _, r := range m.requests {
		var b strings.Builder
		if r.Config != nil && r.Config.SystemInstruction != nil {
			for _, p := range r.Config.SystemInstruction.Parts {
				b.WriteString(p.Text)
			}
		}
		out = append(out, b.String())
	}
	return out
}

func call(name string, args map[string]any) *model.LLMResponse {
	return googleadk.FunctionCallResponse("call-"+name, name, args)
}

func transfer(agentName string) *model.LLMResponse {
	return call("transfer_to_agent", map[string]any{"agent_name": agentName})
}

func text(s string) *model.LLMResponse { return googleadk.TextResponse(s) }

// copyData returns a data store on a fresh copy of the demo data, so tests don't change data/.
func copyData(t *testing.T) *data.Store { return testfixtures.Store(t) }

// fakeChaos is a chaos.Source whose flags the test sets. A flag can be on for only its
// first n checks, so an outage ends by itself.
type fakeChaos struct {
	mu     sync.Mutex
	on     map[chaos.Flag]int // remaining checks the flag is on; -1 means always
	events []chaos.Event
}

func newFakeChaos() *fakeChaos { return &fakeChaos{on: map[chaos.Flag]int{}} }

func (f *fakeChaos) set(flag chaos.Flag, checks int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.on[flag] = checks
}

func (f *fakeChaos) IsEnabled(_ context.Context, flag chaos.Flag) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	n, ok := f.on[flag]
	switch {
	case !ok || n == 0:
		return false
	case n > 0:
		f.on[flag] = n - 1
	}
	return true
}

func (f *fakeChaos) RecordEvent(_ context.Context, e chaos.Event) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.events = append(f.events, e)
}

func (f *fakeChaos) count(flag chaos.Flag) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, e := range f.events {
		if e.Flag == flag {
			n++
		}
	}
	return n
}

// chatEnv is a test environment running the chat workflow with a scripted model.
type chatEnv struct {
	*testsuite.TestWorkflowEnvironment
	store    *data.Store
	chaos    *fakeChaos
	model    *scriptedModel
	approved []string
}

const testChatID = "chat-test"

func newChatEnv(t *testing.T, m model.LLM) *chatEnv {
	t.Helper()
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	ce := &chatEnv{TestWorkflowEnvironment: env, store: copyData(t), chaos: newFakeChaos()}
	if sm, ok := m.(*scriptedModel); ok {
		ce.model = sm
	}

	chat := &Chat{Config: ChatConfig{OpenAccountTaskQueue: "test", LLMTaskQueue: "test-llm", ModelName: testModel}}
	env.RegisterWorkflowWithOptions(chat.Run, workflow.RegisterOptions{Name: WealthManagementWorkflowName})
	env.RegisterWorkflowWithOptions(OpenInvestmentAccountWorkflow, workflow.RegisterOptions{Name: OpenInvestmentAccountWorkflowName})

	acts := &activities.Activities{Data: ce.store, Chaos: ce.chaos, Events: eventstream.NewMemory()}
	acts.Register(env)
	// The chat-side open-account activities reach the child through the Temporal client,
	// which the test environment doesn't have: stand in for them.
	env.RegisterActivityWithOptions(func(ctx context.Context, workflowID string) (domain.WealthManagementClient, error) {
		c, err := ce.store.GetClient("123")
		return *c, err
	}, activity.RegisterOptions{Name: activities.GetCurrentClientInfo})
	env.RegisterActivityWithOptions(func(ctx context.Context, workflowID string) error {
		ce.approved = append(ce.approved, workflowID)
		return nil
	}, activity.RegisterOptions{Name: activities.ApproveKYC})

	modelActs, err := googleadk.NewActivities(googleadk.Config{Models: map[string]googleadk.ModelFactory{
		testModel: func(context.Context, string) (model.LLM, error) { return m, nil },
	}})
	require.NoError(t, err)
	env.RegisterActivityWithOptions(modelActs.InvokeModel, activity.RegisterOptions{Name: googleadk.InvokeModelActivityName})
	env.SetStartWorkflowOptions(clientStartOptions(testChatID))
	return ce
}

// run sends the messages one by one, a minute apart, then ends the chat.
func (ce *chatEnv) run(t *testing.T, messages ...string) []domain.ChatInteraction {
	t.Helper()
	for i, m := range messages {
		ce.RegisterDelayedCallback(func() {
			ce.SignalWorkflow(SignalProcessUserMessage, domain.ProcessUserMessageInput{UserInput: m})
		}, minutes(i+1))
	}
	var history []domain.ChatInteraction
	ce.RegisterDelayedCallback(func() {
		v, err := ce.QueryWorkflow(QueryGetChatHistory)
		require.NoError(t, err)
		require.NoError(t, v.Get(&history))
		ce.SignalWorkflow(SignalEndWorkflow, nil)
	}, minutes(len(messages)+1))
	ce.ExecuteWorkflow(WealthManagementWorkflowName)
	require.True(t, ce.IsWorkflowCompleted())
	require.NoError(t, ce.GetWorkflowError())
	require.Len(t, history, len(messages))
	return history
}
