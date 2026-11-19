package workflows

import (
	"context"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	enumspb "go.temporal.io/api/enums/v1"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/converter"
	"go.temporal.io/sdk/interceptor"
	"go.temporal.io/sdk/testsuite"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"

	"github.com/temporal-sa/adk-go-wealth-management/internal/activities"
	"github.com/temporal-sa/adk-go-wealth-management/internal/chaos"
	"github.com/temporal-sa/adk-go-wealth-management/internal/data"
	"github.com/temporal-sa/adk-go-wealth-management/internal/domain"
	"github.com/temporal-sa/adk-go-wealth-management/internal/eventstream"
	"github.com/temporal-sa/adk-go-wealth-management/internal/llm"
	"github.com/temporal-sa/adk-go-wealth-management/internal/prompts"
)

// runOpenAccount runs OpenInvestmentAccountWorkflow on its own, with KYC and compliance
// approved by signals, and returns its result and the states it went through.
func runOpenAccount(t *testing.T, store *data.Store, src chaos.Source, in domain.OpenInvestmentAccountInput) (domain.OpenInvestmentAccountOutput, []string) {
	t.Helper()
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	env.RegisterWorkflowWithOptions(OpenInvestmentAccountWorkflow, workflow.RegisterOptions{Name: OpenInvestmentAccountWorkflowName})
	(&activities.Activities{Data: store, Chaos: src, Events: eventstream.NewMemory()}).Register(env)

	var states []string
	var mu sync.Mutex
	record := func() {
		v, err := env.QueryWorkflow(QueryGetCurrentState)
		require.NoError(t, err)
		var s string
		require.NoError(t, v.Get(&s))
		mu.Lock()
		states = append(states, s)
		mu.Unlock()
	}
	env.RegisterDelayedCallback(func() { record(); env.SignalWorkflow(SignalVerifyKYC, nil) }, time.Minute)
	env.RegisterDelayedCallback(func() { record(); env.SignalWorkflow(SignalComplianceApproved, nil) }, 2*time.Minute)
	env.ExecuteWorkflow(OpenInvestmentAccountWorkflowName, in)
	require.True(t, env.IsWorkflowCompleted())
	require.NoError(t, env.GetWorkflowError())
	var out domain.OpenInvestmentAccountOutput
	require.NoError(t, env.GetWorkflowResult(&out))
	record()
	return out, states
}

func vacation(amount float64) domain.OpenInvestmentAccountInput {
	return domain.OpenInvestmentAccountInput{ClientID: "123", AccountName: "Vacation", InitialAmount: amount}
}

func findAccount(t *testing.T, store *data.Store, name string) *domain.InvestmentRecord {
	t.Helper()
	list, err := store.ListInvestments("123")
	require.NoError(t, err)
	for _, r := range list {
		if r.Name == name {
			return &r
		}
	}
	return nil
}

func TestSagaSuccess(t *testing.T) {
	store := copyData(t)
	out, states := runOpenAccount(t, store, chaos.Off{}, vacation(13000))
	assert.True(t, out.AccountCreated)
	assert.Equal(t, []string{StateWaitingKYC, StateWaitingCompliance, StateComplete}, states)
	acct := findAccount(t, store, "Vacation")
	require.NotNil(t, acct)
	assert.Equal(t, 13000.0, acct.Balance)
	tr, err := store.Credit("123", 0, "probe") // reads the balance without changing it
	require.NoError(t, err)
	assert.Equal(t, 237000.0, tr.BalanceAfter)
}

func TestSagaRollbackCustodianRejects(t *testing.T) {
	store := copyData(t)
	src := newFakeChaos()
	src.set(chaos.CustodianRejects, -1)
	out, states := runOpenAccount(t, store, src, vacation(13000))
	assert.False(t, out.AccountCreated)
	assert.Equal(t, "The account was not opened: The custodian rejected the account registration", out.Message)
	assert.Equal(t, "Rolled back. The account was not opened: The custodian rejected the account registration.", states[len(states)-1])
	assert.Nil(t, findAccount(t, store, "Vacation"), "the account record is removed")
	tr, err := store.Credit("123", 0, "probe")
	require.NoError(t, err)
	assert.Equal(t, 250000.0, tr.BalanceAfter, "the deposit is refunded")
	assert.Equal(t, 1, src.count(chaos.CustodianRejects))
}

func TestSagaRollbackInsufficientFunds(t *testing.T) {
	store := copyData(t)
	out, _ := runOpenAccount(t, store, chaos.Off{}, vacation(300000))
	assert.False(t, out.AccountCreated)
	assert.Contains(t, out.Message, "which is not enough to transfer $300,000.00")
	assert.Nil(t, findAccount(t, store, "Vacation"))
}

// TestSagaStateSequence checks every state the child reports to the chat, in order, for a rollback.
func TestSagaStateSequence(t *testing.T) {
	store := copyData(t)
	src := newFakeChaos()
	src.set(chaos.CustodianRejects, -1)

	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	var reported []string
	parent := func(ctx workflow.Context) error {
		ch := workflow.GetSignalChannel(ctx, SignalUpdateAccountOpeningState)
		workflow.Go(ctx, func(ctx workflow.Context) {
			for {
				var in domain.UpdateAccountOpeningStateInput
				ch.Receive(ctx, &in)
				reported = append(reported, in.State)
			}
		})
		cctx := workflow.WithChildOptions(ctx, workflow.ChildWorkflowOptions{WorkflowID: "child"})
		f := workflow.ExecuteChildWorkflow(cctx, OpenInvestmentAccountWorkflowName, vacation(13000))
		_ = f.GetChildWorkflowExecution().Get(ctx, nil)
		_ = workflow.Sleep(ctx, time.Minute)
		_ = workflow.SignalExternalWorkflow(ctx, "child", "", SignalVerifyKYC, nil).Get(ctx, nil)
		_ = workflow.SignalExternalWorkflow(ctx, "child", "", SignalComplianceApproved, nil).Get(ctx, nil)
		var out domain.OpenInvestmentAccountOutput
		if err := f.Get(ctx, &out); err != nil {
			return err
		}
		return workflow.Sleep(ctx, time.Second) // let the last signals arrive
	}
	env.RegisterWorkflowWithOptions(parent, workflow.RegisterOptions{Name: "parent"})
	env.RegisterWorkflowWithOptions(OpenInvestmentAccountWorkflow, workflow.RegisterOptions{Name: OpenInvestmentAccountWorkflowName})
	(&activities.Activities{Data: store, Chaos: src, Events: eventstream.NewMemory()}).Register(env)
	env.ExecuteWorkflow("parent")
	require.NoError(t, env.GetWorkflowError())

	reason := "The custodian rejected the account registration"
	assert.Equal(t, []string{
		StateWaitingKYC,
		StateWaitingCompliance,
		StateComplianceApproved,
		StateCreatingRecord,
		"Transferring $13,000.00 from the linked bank account.",
		StateRegistering,
		"Failed: " + reason + ". Rolling back.",
		"Rolling back: refunding $13,000.00 to the linked bank account.",
		"Rolling back: removing the account record.",
		"Rolled back. The account was not opened: " + reason + ".",
	}, reported)
}

// TestToolOutageRetries: while the core banking API is down, the saga's activity retries
// until it comes back, and the opening completes.
func TestToolOutageRetries(t *testing.T) {
	store := copyData(t)
	src := newFakeChaos()
	src.set(chaos.ToolDown, 3) // down for the next three calls
	out, _ := runOpenAccount(t, store, src, vacation(500))
	assert.True(t, out.AccountCreated)
	assert.Equal(t, 3, src.count(chaos.ToolDown))
}

// TestModelOutageRetries: while the model API is down, the model activity retries and the
// turn resumes where it stopped.
func TestModelOutageRetries(t *testing.T) {
	src := newFakeChaos()
	src.set(chaos.LLMDown, 2)
	inner := newScriptedModel(
		transfer(prompts.BeneficiaryAgentName),
		call("list_beneficiaries", map[string]any{"client_id": "123"}),
		text("Your beneficiaries are Junior Doe, Juniorette Doe and Jane Doe."),
	)
	ce := newChatEnv(t, &llm.Chaos{Inner: inner, Src: src})
	history := ce.run(t, "Who are my beneficiaries? My client ID is 123.")
	assert.Contains(t, history[0].TextResponse, "Junior Doe")
	assert.Equal(t, 2, src.count(chaos.LLMDown))
	assert.Len(t, inner.requests, 3, "each model call reaches the model once the outage is over")
}

// TestRateLimitRetryDelay: a 429 sets the model activity's next retry delay to 15 s,
// overriding the retry policy's backoff.
func TestRateLimitRetryDelay(t *testing.T) {
	src := newFakeChaos()
	src.set(chaos.LLMRateLimited, 1)
	inner := newScriptedModel(text("Hello! How can I help with your beneficiaries or investment accounts?"))
	ce := newChatEnv(t, &llm.Chaos{Inner: inner, Src: src})
	ce.SetWorkerOptions(worker.Options{Interceptors: []interceptor.WorkerInterceptor{&llm.RateLimitInterceptor{}}})

	var attempts []time.Time
	ce.SetOnActivityStartedListener(func(info *activity.Info, _ context.Context, _ converter.EncodedValues) {
		if info.ActivityType.Name == "googleadk.InvokeModel" {
			attempts = append(attempts, ce.Now())
		}
	})
	history := ce.run(t, "Hi")
	assert.Contains(t, history[0].TextResponse, "How can I help")
	require.Len(t, attempts, 2)
	assert.GreaterOrEqual(t, attempts[1].Sub(attempts[0]), llm.RateLimitRetryAfter)

	err := llm.RetryAfter(&llm.RateLimitedError{Msg: "429"})
	assert.True(t, llm.IsRateLimited(err))
}

// TestWorkflowBugPausesWorkflow: with the WELCOME-BONUS promo code, the bug in workflow
// code fails the workflow task after compliance approval, but not the workflow: it stays
// Running, with the approval kept. It needs the Temporal CLI's dev server (the `temporal`
// binary on PATH, or downloaded by the SDK).
func TestWorkflowBugPausesWorkflow(t *testing.T) {
	if testing.Short() {
		t.Skip("starts a Temporal dev server")
	}
	opts := testsuite.DevServerOptions{LogLevel: "error"}
	if path, err := exec.LookPath("temporal"); err == nil {
		opts.ExistingPath = path
	}
	srv, err := testsuite.StartDevServer(context.Background(), opts)
	if err != nil {
		t.Skipf("no Temporal dev server: %v", err)
	}
	defer srv.Stop()
	c := srv.Client()

	store := copyData(t)
	w := worker.New(c, "bug-test", worker.Options{})
	w.RegisterWorkflowWithOptions(OpenInvestmentAccountWorkflow, workflow.RegisterOptions{Name: OpenInvestmentAccountWorkflowName})
	(&activities.Activities{Data: store, Chaos: chaos.Off{}, Events: eventstream.NewMemory()}).Register(w)
	require.NoError(t, w.Start())
	defer w.Stop()

	ctx := context.Background()
	promo := activities.WelcomeBonusPromo
	in := vacation(500)
	in.PromoCode = &promo
	run, err := c.ExecuteWorkflow(ctx, client.StartWorkflowOptions{ID: "bug-test-1", TaskQueue: "bug-test"},
		OpenInvestmentAccountWorkflowName, in)
	require.NoError(t, err)
	waitForState(t, c, run.GetID(), StateWaitingKYC)
	require.NoError(t, c.SignalWorkflow(ctx, run.GetID(), "", SignalVerifyKYC, nil))
	waitForState(t, c, run.GetID(), StateWaitingCompliance)
	require.NoError(t, c.SignalWorkflow(ctx, run.GetID(), "", SignalComplianceApproved, nil))

	// The workflow task fails, and is retried, but the workflow keeps running.
	require.Eventually(t, func() bool { return countWorkflowTaskFailures(t, c, run) >= 1 }, 30*time.Second, 200*time.Millisecond)
	desc, err := c.DescribeWorkflowExecution(ctx, run.GetID(), "")
	require.NoError(t, err)
	assert.Equal(t, enumspb.WORKFLOW_EXECUTION_STATUS_RUNNING, desc.WorkflowExecutionInfo.Status)
	assert.Nil(t, findAccount(t, store, "Vacation"), "the saga hasn't started")
	require.NoError(t, c.TerminateWorkflow(ctx, run.GetID(), "", "test done"))
}

func waitForState(t *testing.T, c client.Client, id, want string) {
	t.Helper()
	require.Eventually(t, func() bool {
		v, err := c.QueryWorkflow(context.Background(), id, "", QueryGetCurrentState)
		if err != nil {
			return false
		}
		var s string
		return v.Get(&s) == nil && s == want
	}, 30*time.Second, 100*time.Millisecond)
}

func countWorkflowTaskFailures(t *testing.T, c client.Client, run client.WorkflowRun) int {
	it := c.GetWorkflowHistory(context.Background(), run.GetID(), run.GetRunID(), false, enumspb.HISTORY_EVENT_FILTER_TYPE_ALL_EVENT)
	n := 0
	for it.HasNext() {
		e, err := it.Next()
		require.NoError(t, err)
		if e.GetEventType() == enumspb.EVENT_TYPE_WORKFLOW_TASK_FAILED {
			attrs := e.GetWorkflowTaskFailedEventAttributes()
			if strings.Contains(attrs.GetFailure().GetMessage(), "nil pointer") {
				n++
			}
		}
	}
	return n
}
