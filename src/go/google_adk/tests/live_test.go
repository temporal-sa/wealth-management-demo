//go:build live

// Live tests: the real chat workflow and the real Gemini model, on a Temporal dev server
// started by the test. The Redis event stream is replaced with an in-memory one and the
// chaos flags read as off. They call the paid model API, so they are kept out of the
// default run:
//
//	GEMINI_API_KEY=... LIVE_TEST_RUNS=3 go test -tags live ./tests/ -v
//
// Each test repeats its conversation LIVE_TEST_RUNS times (default 1); every run must
// pass. Each run's transcript is printed.
package tests

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/interceptor"
	"go.temporal.io/sdk/testsuite"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"

	"go.temporal.io/googleadk"

	"github.com/temporal-sa/adk-go-wealth-management/internal/activities"
	"github.com/temporal-sa/adk-go-wealth-management/internal/chaos"
	"github.com/temporal-sa/adk-go-wealth-management/internal/config"
	"github.com/temporal-sa/adk-go-wealth-management/internal/data"
	"github.com/temporal-sa/adk-go-wealth-management/internal/domain"
	"github.com/temporal-sa/adk-go-wealth-management/internal/eventstream"
	"github.com/temporal-sa/adk-go-wealth-management/internal/llm"
	"github.com/temporal-sa/adk-go-wealth-management/internal/testfixtures"
	"github.com/temporal-sa/adk-go-wealth-management/internal/workflows"
)

const taskQueue = "live-test"

var handoffMessages = []string{"Who are my beneficiaries?", "123", "What investments do I have?"}

// TestLiveAgentHandoffs: after listing beneficiaries, "What investments do I have?" goes
// from the Beneficiary Agent to the supervisor to the Investment Agent in the same turn,
// and the Investment Agent lists the accounts without asking for the client ID again.
func TestLiveAgentHandoffs(t *testing.T) {
	c := startEnv(t)
	for run := 1; run <= runs(); run++ {
		t.Run(fmt.Sprintf("run-%d", run), func(t *testing.T) {
			history, _ := chat(t, c, fmt.Sprintf("live-handoffs-%d-%d", time.Now().Unix(), run), handoffMessages)
			last := history[2]
			assert.Contains(t, history[1].TextResponse, "John", "the beneficiaries are listed")
			assert.Contains(t, last.AgentTrace, "Handed off from Beneficiary_Agent to Supervisor_Agent")
			assert.Contains(t, last.AgentTrace, "Handed off from Supervisor_Agent to Investment_Agent")
			for _, acct := range []string{"Checking", "Savings", "401K"} {
				assert.Contains(t, last.TextResponse, acct)
			}
			assert.NotContains(t, strings.ToLower(last.TextResponse), "client id", "the client ID isn't asked for again")
			for i, h := range history {
				assert.NotContains(t, strings.ToLower(h.TextResponse), "transfer", "reply %d mentions a transfer", i+1)
			}
		})
	}
}

// TestLiveRepeatOpening: two requests to open "Vacation" in one chat each start a new
// opening, with its own KYC.
func TestLiveRepeatOpening(t *testing.T) {
	c := startEnv(t)
	for run := 1; run <= runs(); run++ {
		t.Run(fmt.Sprintf("run-%d", run), func(t *testing.T) {
			id := fmt.Sprintf("live-repeat-%d-%d", time.Now().Unix(), run)
			msgs := append(append([]string{}, handoffMessages...),
				"Open Vacation with $13,000", "Yes", "Open Vacation with $13,000")
			history, states := chat(t, c, id, msgs)
			for _, i := range []int{3, 5} {
				assert.Contains(t, history[i].TextResponse, "Don", "reply %d shows the KYC details", i+1)
				assert.Contains(t, history[i].TextResponse, "123 Main Street", "reply %d shows the KYC details", i+1)
			}
			prefix := "OpenAccount-" + id + "-123-Vacation-"
			assert.Contains(t, states, prefix+"1")
			assert.Contains(t, states, prefix+"2")
		})
	}
}

func runs() int {
	if n, err := strconv.Atoi(os.Getenv("LIVE_TEST_RUNS")); err == nil && n > 0 {
		return n
	}
	return 1
}

// startEnv starts a dev server and a worker running the real workflows and model.
func startEnv(t *testing.T) client.Client {
	t.Helper()
	if os.Getenv("GEMINI_API_KEY") == "" && os.Getenv("GOOGLE_API_KEY") == "" {
		t.Skip("GEMINI_API_KEY is not set")
	}
	opts := testsuite.DevServerOptions{LogLevel: "error"}
	if path, err := exec.LookPath("temporal"); err == nil {
		opts.ExistingPath = path
	}
	srv, err := testsuite.StartDevServer(context.Background(), opts)
	require.NoError(t, err)
	t.Cleanup(func() { _ = srv.Stop() })
	c := srv.Client()

	modelName := config.Load().GeminiModel
	w := worker.New(c, taskQueue, worker.Options{})
	chat := &workflows.Chat{Config: workflows.ChatConfig{
		OpenAccountTaskQueue: taskQueue, LLMTaskQueue: taskQueue + "-llm", ModelName: modelName}}
	w.RegisterWorkflowWithOptions(chat.Run, workflow.RegisterOptions{Name: workflows.WealthManagementWorkflowName})
	w.RegisterWorkflowWithOptions(workflows.OpenInvestmentAccountWorkflow,
		workflow.RegisterOptions{Name: workflows.OpenInvestmentAccountWorkflowName})
	(&activities.Activities{Data: copyData(t), Chaos: chaos.Off{}, Events: eventstream.NewMemory(), Client: c}).Register(w)

	plugin, err := googleadk.NewPlugin(googleadk.Config{
		Models: map[string]googleadk.ModelFactory{modelName: llm.NewGeminiFactory(chaos.Off{})}})
	require.NoError(t, err)
	llmWorker := worker.New(c, taskQueue+"-llm", worker.Options{
		Plugins:      []worker.Plugin{plugin},
		Interceptors: []interceptor.WorkerInterceptor{&llm.RateLimitInterceptor{}},
	})
	require.NoError(t, w.Start())
	require.NoError(t, llmWorker.Start())
	t.Cleanup(func() { w.Stop(); llmWorker.Stop() })
	return c
}

// chat runs a conversation, one message at a time, and prints its transcript. It returns
// the chat history and the account openings' states.
func chat(t *testing.T, c client.Client, id string, messages []string) ([]domain.ChatInteraction, map[string]string) {
	t.Helper()
	ctx := context.Background()
	_, err := c.ExecuteWorkflow(ctx, client.StartWorkflowOptions{ID: id, TaskQueue: taskQueue}, workflows.WealthManagementWorkflowName)
	require.NoError(t, err)
	defer func() { _ = c.SignalWorkflow(ctx, id, "", workflows.SignalEndWorkflow, nil) }()

	var history []domain.ChatInteraction
	for i, m := range messages {
		require.NoError(t, c.SignalWorkflow(ctx, id, "", workflows.SignalProcessUserMessage, domain.ProcessUserMessageInput{UserInput: m}))
		require.Eventually(t, func() bool {
			v, err := c.QueryWorkflow(ctx, id, "", workflows.QueryGetChatHistory)
			if err != nil {
				return false
			}
			history = nil
			return v.Get(&history) == nil && len(history) > i
		}, 3*time.Minute, 500*time.Millisecond, "no reply to %q", m)
	}
	var states map[string]string
	v, err := c.QueryWorkflow(ctx, id, "", workflows.QueryGetAccountOpeningStates)
	require.NoError(t, err)
	require.NoError(t, v.Get(&states))

	var b strings.Builder
	fmt.Fprintf(&b, "\n===== Transcript %s =====\n", id)
	for _, h := range history {
		fmt.Fprintf(&b, "Customer: %s\n", h.UserPrompt)
		if h.AgentTrace != "" {
			fmt.Fprintf(&b, "  %s\n", strings.ReplaceAll(strings.TrimSpace(h.AgentTrace), "\n", "\n  "))
		}
		fmt.Fprintf(&b, "Agent: %s\n\n", strings.TrimSpace(h.TextResponse))
	}
	t.Log(b.String())
	return history, states
}

func copyData(t *testing.T) *data.Store { return testfixtures.Store(t) }
