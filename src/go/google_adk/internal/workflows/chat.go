package workflows

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	enumspb "go.temporal.io/api/enums/v1"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"

	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/runner"
	"google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/genai"

	"go.temporal.io/googleadk"

	"github.com/temporal-sa/adk-go-wealth-management/internal/activities"
	"github.com/temporal-sa/adk-go-wealth-management/internal/agents"
	"github.com/temporal-sa/adk-go-wealth-management/internal/domain"
	"github.com/temporal-sa/adk-go-wealth-management/internal/prompts"
)

// Names of WealthManagementWorkflow and its handlers (the shared Temporal contract).
const (
	WealthManagementWorkflowName    = "WealthManagementWorkflow"
	SignalProcessUserMessage        = "process_user_message"
	SignalEndWorkflow               = "end_workflow"
	SignalUpdateAccountOpeningState = "update_account_opening_state"
	QueryGetChatHistory             = "get_chat_history"
	// QueryGetAccountOpeningStates returns the latest state of each account opening, keyed
	// by its workflow ID. It is not part of the shared contract; the tests use it.
	QueryGetAccountOpeningStates = "get_account_opening_states"
)

const (
	appName = "wealth-management"
	userID  = "workflow-user"

	// Sent when the model ends a turn with no text and no tool call, which Gemini occasionally does.
	emptyResponseNudge    = "Please continue, following your instructions."
	emptyResponseFallback = "Sorry, I didn't catch that. Could you please say it again?"
	errorResponse         = "Sorry, something went wrong while handling your request. Please try again."
)

// kycDisplayedFields must all appear in a reply for the customer's details to count as shown.
var kycDisplayedFields = []string{"first_name", "last_name", "email"}

// ChatConfig is the chat workflow's configuration, read from the environment by the worker.
type ChatConfig struct {
	// OpenAccountTaskQueue runs the open-account child workflows.
	OpenAccountTaskQueue string
	// LLMTaskQueue runs the model calls.
	LLMTaskQueue string
	// ModelName is the model every agent uses. The worker builds the real model from it.
	ModelName string
}

// Chat is the chat workflow, WealthManagementWorkflow. Register its Run method under
// WealthManagementWorkflowName.
type Chat struct {
	Config ChatConfig
}

// chat is one run of the chat workflow. Everything the agents need to remember between
// turns is kept here, in workflow state, so it is deterministic and survives replay.
type chat struct {
	cfg  ChatConfig
	wfID string

	chatHistory     []domain.ChatInteraction
	pendingMessages []string
	pendingStatuses []string
	endWorkflow     bool

	// The customer's client ID, once a tool has been called with it.
	clientID string
	// Latest state reported by each open-account child workflow, keyed by its workflow ID.
	accountOpeningStates map[string]string
	// Number of account openings started in this conversation. The next opening's
	// workflow ID ends with this number plus one.
	accountOpeningsStarted int
	// KYC guard (see approveKYC): the number of the customer message being handled, the
	// client details fetched for each account opening this turn, and the turn in which
	// they were shown to the customer, keyed by the opening's workflow ID.
	turn                int
	kycDetailsFetched   map[string]domain.WealthManagementClient
	kycDetailsShownTurn map[string]int
}

// Run is the chat workflow: it runs the agents for each customer message, one at a time,
// and records each account opening's state from its child workflow's signals.
func (c *Chat) Run(ctx workflow.Context) error {
	s := &chat{
		cfg:                  c.Config,
		wfID:                 workflow.GetInfo(ctx).WorkflowExecution.ID,
		accountOpeningStates: map[string]string{},
		kycDetailsFetched:    map[string]domain.WealthManagementClient{},
		kycDetailsShownTurn:  map[string]int{},
	}
	if err := s.registerHandlers(ctx); err != nil {
		return err
	}

	// The UI reuses chat workflow IDs, so drop any earlier conversation stored under this one.
	s.localActivity(ctx, activities.DeleteConversation, s.wfID)

	root, err := agents.Build(s.agentOptions())
	if err != nil {
		return err
	}
	r, err := runner.New(runner.Config{
		AppName:           appName,
		Agent:             root,
		SessionService:    session.InMemoryService(),
		AutoCreateSession: true,
	})
	if err != nil {
		return err
	}

	for {
		if err := workflow.Await(ctx, func() bool {
			return len(s.pendingMessages) > 0 || len(s.pendingStatuses) > 0 || s.endWorkflow
		}); err != nil {
			return err
		}
		if s.endWorkflow {
			workflow.GetLogger(ctx).Info("Ending chat")
			return nil
		}
		if len(s.pendingMessages) > 0 {
			msg := s.pendingMessages[0]
			s.pendingMessages = s.pendingMessages[1:]
			s.processChatMessage(ctx, r, msg)
		}
		if len(s.pendingStatuses) > 0 {
			status := s.pendingStatuses[0]
			s.pendingStatuses = s.pendingStatuses[1:]
			s.localActivity(ctx, activities.AppendStatusUpdate, s.wfID, domain.StatusUpdate{Status: status})
		}

		// TODO: Continue-As-New.
		// This demo keeps the whole conversation in one workflow run. A production system
		// would continue-as-new when workflow.GetInfo(ctx).GetContinueAsNewSuggested() is
		// true, because Temporal limits a run's event history (warnings at 10K events / 10 MB,
		// terminated at 50K events / 50 MB) and every model and tool call adds events, so a
		// long chat would eventually hit those limits. To do it safely:
		//   - Wait for workflow.AllHandlersFinished and drain the pending message and status
		//     queues first, so no customer message or status update is lost.
		//   - Carry the conversation state into the new run: the ADK session (see
		//     googleadk.ExportSession / ImportSession), the client ID, the account-opening
		//     states and count, and the KYC guard's turn tracking.
		//   - Open-account child workflows are started with PARENT_CLOSE_POLICY_TERMINATE,
		//     which also applies when the parent continues-as-new, so an opening waiting for
		//     KYC or compliance would be terminated. Use ABANDON and have end_workflow cancel
		//     any openings still running, or defer continue-as-new until none is in progress.
	}
}

func (s *chat) registerHandlers(ctx workflow.Context) error {
	if err := workflow.SetQueryHandler(ctx, QueryGetChatHistory, func() ([]domain.ChatInteraction, error) {
		if s.chatHistory == nil {
			return []domain.ChatInteraction{}, nil
		}
		return s.chatHistory, nil
	}); err != nil {
		return err
	}
	if err := workflow.SetQueryHandler(ctx, QueryGetAccountOpeningStates, func() (map[string]string, error) {
		return s.accountOpeningStates, nil
	}); err != nil {
		return err
	}

	// Each signal is received in its own coroutine, so it is recorded at once, even in the
	// middle of a turn: an account opening's state is up to date for the agents' next status check.
	messages := workflow.GetSignalChannel(ctx, SignalProcessUserMessage)
	workflow.Go(ctx, func(ctx workflow.Context) {
		for {
			var in domain.ProcessUserMessageInput
			messages.Receive(ctx, &in)
			workflow.GetLogger(ctx).Info("Received user message", "message", in.UserInput)
			s.pendingMessages = append(s.pendingMessages, in.UserInput)
		}
	})
	end := workflow.GetSignalChannel(ctx, SignalEndWorkflow)
	workflow.Go(ctx, func(ctx workflow.Context) {
		end.Receive(ctx, nil)
		s.endWorkflow = true
	})
	states := workflow.GetSignalChannel(ctx, SignalUpdateAccountOpeningState)
	workflow.Go(ctx, func(ctx workflow.Context) {
		for {
			var in domain.UpdateAccountOpeningStateInput
			states.Receive(ctx, &in)
			if in.WorkflowID != nil && *in.WorkflowID != "" {
				s.accountOpeningStates[*in.WorkflowID] = in.State
			}
			s.pendingStatuses = append(s.pendingStatuses,
				fmt.Sprintf("New %s account status changed: %s", in.AccountName, in.State))
		}
	})
	return nil
}

// processChatMessage runs one turn and appends it to the chat history and the event stream.
func (s *chat) processChatMessage(ctx workflow.Context, r *runner.Runner, message string) {
	s.turn++
	s.kycDetailsFetched = map[string]domain.WealthManagementClient{}
	ci := domain.ChatInteraction{UserPrompt: message}

	text, trace, jsonResp := s.runAgents(ctx, r, message)
	if strings.TrimSpace(text) == "" {
		// The model ended the turn without saying anything. Nudge it once, then fall back to
		// a canned reply rather than show the customer an empty message.
		workflow.GetLogger(ctx).Warn("Model returned no text; nudging it once")
		var retryTrace, retryJSON string
		text, retryTrace, retryJSON = s.runAgents(ctx, r, emptyResponseNudge)
		trace += retryTrace
		jsonResp += retryJSON
		if strings.TrimSpace(text) == "" {
			text = emptyResponseFallback
		}
	}

	// Details only count as shown if the reply the customer sees contains them.
	for openingID, details := range s.kycDetailsFetched {
		if detailsDisplayed(details, text) {
			s.kycDetailsShownTurn[openingID] = s.turn
		}
	}

	ci.TextResponse, ci.AgentTrace, ci.JSONResponse = text, trace, jsonResp
	s.chatHistory = append(s.chatHistory, ci)
	s.localActivity(ctx, activities.AppendChatInteraction, s.wfID, ci)
}

// runAgents runs the agents on one message. It returns the reply text, the agent trace
// (handoffs and tool calls) and the tool results.
func (s *chat) runAgents(ctx workflow.Context, r *runner.Runner, message string) (text, trace, jsonResp string) {
	// Tools run one at a time: the open-account tool numbers each opening from workflow state.
	adkCtx := googleadk.NewContext(ctx, googleadk.WithSequentialToolFanout())
	msg := genai.NewContentFromText(message, genai.RoleUser)
	var b, t, j strings.Builder
	for ev, err := range r.Run(adkCtx, userID, s.wfID, msg, agent.RunConfig{}) {
		if err != nil {
			workflow.GetLogger(ctx).Error("Agent run failed", "error", err)
			fmt.Fprintf(&t, "error: %v\n", err)
			if b.Len() == 0 {
				b.WriteString(errorResponse)
			}
			break
		}
		if ev == nil {
			continue
		}
		hasCalls := false
		if ev.Content != nil {
			for _, p := range ev.Content.Parts {
				if p == nil {
					continue
				}
				if p.FunctionCall != nil {
					hasCalls = true
					if p.FunctionCall.Name != "transfer_to_agent" {
						fmt.Fprintf(&t, "%s: Calling a tool: %s\n", ev.Author, p.FunctionCall.Name)
					}
				}
				if p.FunctionResponse != nil && p.FunctionResponse.Name != "transfer_to_agent" {
					out, _ := json.Marshal(p.FunctionResponse.Response)
					j.Write(out)
					j.WriteByte('\n')
				}
			}
			if !hasCalls {
				for _, p := range ev.Content.Parts {
					if p != nil && p.Text != "" && !p.Thought {
						b.WriteString(p.Text)
					}
				}
			}
		}
		if target := ev.Actions.TransferToAgent; target != "" {
			fmt.Fprintf(&t, "Handed off from %s to %s\n", ev.Author, target)
		}
	}
	return b.String(), t.String(), j.String()
}

func detailsDisplayed(details domain.WealthManagementClient, reply string) bool {
	reply = strings.ToLower(reply)
	for _, f := range kycDisplayedFields {
		if v := strings.ToLower(details.Field(f)); v != "" && !strings.Contains(reply, v) {
			return false
		}
	}
	return true
}

// localActivity runs an event-stream activity. If Redis can't be reached it gives up
// after a few seconds and the chat carries on: the conversation is still in the workflow.
func (s *chat) localActivity(ctx workflow.Context, name string, args ...any) {
	lctx := workflow.WithLocalActivityOptions(ctx, workflow.LocalActivityOptions{
		ScheduleToCloseTimeout: 5 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    time.Second,
			BackoffCoefficient: 2,
			MaximumInterval:    30 * time.Second,
		},
	})
	if err := workflow.ExecuteLocalActivity(lctx, name, args...).Get(ctx, nil); err != nil {
		workflow.GetLogger(ctx).Warn("Event stream activity failed", "activity", name, "error", err)
	}
}

// ---------------------------------------------------------------------------
// Agents and tools
// ---------------------------------------------------------------------------

func (s *chat) agentOptions() agents.Options {
	return agents.Options{
		Model:                  s.model,
		ClientID:               func() string { return s.clientID },
		RememberClientID:       func(id string) { s.clientID = id },
		BeneficiaryTools:       s.beneficiaryTools(),
		InvestmentTools:        s.investmentTools(),
		OpenAccountTools:       s.openAccountTools(),
		InvestmentInstructions: prompts.InvestmentInstructions,
	}
}

// model is the agent's model: its calls run as the googleadk InvokeModel activity on the
// LLM task queue, retried until the model responds.
func (s *chat) model(agentName string) model.LLM {
	return googleadk.NewModel(s.cfg.ModelName,
		googleadk.WithModelActivityOptions(workflow.ActivityOptions{
			TaskQueue:           s.cfg.LLMTaskQueue,
			StartToCloseTimeout: ModelTimeout,
			RetryPolicy:         LLMRetryPolicy,
		}),
		googleadk.WithModelSummary(func(*model.LLMRequest) string { return agentName }),
	)
}

// errNotInWorkflow is returned if a tool runs outside googleadk.NewContext.
var errNotInWorkflow = errors.New("tool called outside the workflow")

// toolActivity runs a tool activity from inside a tool, with the tool retry policy.
func toolActivity(ctx agent.Context, name string, timeout time.Duration, result any, args ...any) error {
	wctx, ok := googleadk.WorkflowContext(ctx)
	if !ok {
		return errNotInWorkflow
	}
	actx := workflow.WithActivityOptions(wctx, workflow.ActivityOptions{
		StartToCloseTimeout: timeout,
		RetryPolicy:         ToolRetryPolicy,
		Summary:             ctx.AgentName() + ": " + name,
	})
	return workflow.ExecuteActivity(actx, name, args...).Get(wctx, result)
}

func (s *chat) beneficiaryTools() []tool.Tool {
	return []tool.Tool{
		mustTool(activities.ListBeneficiaries, "List a client's beneficiaries.",
			func(ctx agent.Context, in clientIDArgs) ([]domain.BeneficiaryRecord, error) {
				var out []domain.BeneficiaryRecord
				return out, toolActivity(ctx, activities.ListBeneficiaries, ToolTimeout, &out, in.ClientID)
			}),
		mustTool(activities.AddBeneficiary, "Add a new beneficiary for a client.",
			func(ctx agent.Context, in addBeneficiaryArgs) (string, error) {
				err := toolActivity(ctx, activities.AddBeneficiary, ToolTimeout, nil, domain.Beneficiary(in))
				return "Beneficiary added.", err
			}),
		mustTool(activities.DeleteBeneficiary, "Delete a client's beneficiary by its beneficiary ID.",
			func(ctx agent.Context, in deleteBeneficiaryArgs) (string, error) {
				err := toolActivity(ctx, activities.DeleteBeneficiary, ToolTimeout, nil, in.ClientID, in.BeneficiaryID)
				return "Beneficiary deleted.", err
			}),
	}
}

func (s *chat) investmentTools() []tool.Tool {
	return []tool.Tool{
		mustTool(activities.ListInvestments, "List a client's investment accounts and their balances.",
			func(ctx agent.Context, in clientIDArgs) ([]domain.InvestmentRecord, error) {
				var out []domain.InvestmentRecord
				return out, toolActivity(ctx, activities.ListInvestments, ToolTimeout, &out, in.ClientID)
			}),
		mustTool(activities.CloseInvestment, "Close a client's investment account by its investment ID.",
			func(ctx agent.Context, in closeInvestmentArgs) (string, error) {
				err := toolActivity(ctx, activities.CloseInvestment, ToolTimeout, nil, in.ClientID, in.InvestmentID)
				return "Investment account closed.", err
			}),
	}
}

func (s *chat) openAccountTools() []tool.Tool {
	return []tool.Tool{
		mustTool("open_new_investment_account",
			"Begin opening a new investment account. Returns the workflow ID of the account opening, "+
				"which the other open-account tools require, or the reason the account cannot be opened.",
			s.openNewInvestmentAccount),
		mustTool("get_account_opening_status",
			"Get the current status of an account opening. \"Complete\" means the account was opened; "+
				"a status starting with \"Rolled back\" means it was not opened. Either way, that account opening is finished.",
			s.getAccountOpeningStatus),
		mustTool(activities.GetCurrentClientInfo,
			"Retrieve the customer's current details for an account opening, to show them for KYC. "+
				"Show all of them to the customer and ask whether they are correct.",
			s.getCurrentClientInfo),
		mustTool(activities.ApproveKYC,
			"Approve KYC for an account opening, after the customer confirmed their details are correct. "+
				"Returns whether KYC was approved and, if not, what to do first.",
			s.approveKYC),
		mustTool(activities.UpdateClientDetails,
			"Update one or more of the customer's details during an account opening. Set only the fields that change. "+
				"This completes KYC.",
			s.updateClientDetails),
	}
}

// openNewInvestmentAccount validates the request, then starts an open-account child
// workflow. Every request starts a new account opening, with its own number.
func (s *chat) openNewInvestmentAccount(ctx agent.Context, in openAccountArgs) (string, error) {
	wctx, ok := googleadk.WorkflowContext(ctx)
	if !ok {
		return "", errNotInWorkflow
	}
	// Business rules are checked up front. A broken rule is a non-retryable error: it fails
	// on the first attempt, and the reason goes back to the agent.
	if err := toolActivity(ctx, activities.ValidateNewAccount, 5*time.Second, nil,
		in.ClientID, in.AccountName, in.InitialAmount); err != nil {
		var appErr *temporal.ApplicationError
		if errors.As(err, &appErr) && appErr.NonRetryable() {
			return "The account cannot be opened: " + appErr.Message(), nil
		}
		return "", err
	}

	// Read in an activity, so the result is recorded in history and replays the same.
	var promo *string
	if err := toolActivity(ctx, activities.FindPromotion, 5*time.Second, &promo, in.ClientID); err != nil {
		return "", err
	}

	// The ID ends with the number of openings started in this conversation, counting this
	// one. The count is workflow state, so it replays the same.
	n := s.accountOpeningsStarted + 1
	childID := fmt.Sprintf("OpenAccount-%s-%s-%s-%d", s.wfID, in.ClientID, in.AccountName, n)
	cctx := workflow.WithChildOptions(wctx, workflow.ChildWorkflowOptions{
		WorkflowID:        childID,
		TaskQueue:         s.cfg.OpenAccountTaskQueue,
		ParentClosePolicy: enumspb.PARENT_CLOSE_POLICY_TERMINATE,
	})
	child := workflow.ExecuteChildWorkflow(cctx, OpenInvestmentAccountWorkflowName, domain.OpenInvestmentAccountInput{
		ClientID:      in.ClientID,
		AccountName:   in.AccountName,
		InitialAmount: in.InitialAmount,
		PromoCode:     promo,
	})
	if err := child.GetChildWorkflowExecution().Get(wctx, nil); err != nil {
		return "", err
	}
	// Counted only once the opening has started.
	s.accountOpeningsStarted = n
	// Known from the start, so a status check right away doesn't report "not found" before
	// the child's first state update arrives.
	if _, ok := s.accountOpeningStates[childID]; !ok {
		s.accountOpeningStates[childID] = StateInitializing
	}
	return childID, nil
}

// getAccountOpeningStatus reads the state the open-account workflow last reported.
func (s *chat) getAccountOpeningStatus(_ agent.Context, in workflowIDArgs) (string, error) {
	state, ok := s.accountOpeningStates[in.WorkflowID]
	if !ok {
		return fmt.Sprintf("No account opening with workflow ID %s was found in this conversation.", in.WorkflowID), nil
	}
	if state == StateComplete || strings.HasPrefix(state, "Rolled back") {
		// The model has read a finished opening's status as the answer to a new request to
		// open the same account, so say what to do in that case.
		return state + "\nThis account opening is finished. If the customer is asking to open an account now, " +
			"call open_new_investment_account to start a new account opening.", nil
	}
	return state, nil
}

func (s *chat) getCurrentClientInfo(ctx agent.Context, in workflowIDArgs) (domain.WealthManagementClient, error) {
	var details domain.WealthManagementClient
	if err := toolActivity(ctx, activities.GetCurrentClientInfo, ToolTimeout, &details, in.WorkflowID); err != nil {
		return details, err
	}
	s.kycDetailsFetched[in.WorkflowID] = details
	return details, nil
}

// approveKYC approves KYC only once this opening's details were shown in a reply and the
// customer has answered since. The model sometimes approves KYC without showing the
// customer their details, or treats a confirmation for an earlier opening as approval for
// a new one.
func (s *chat) approveKYC(ctx agent.Context, in workflowIDArgs) (string, error) {
	shown, ok := s.kycDetailsShownTurn[in.WorkflowID]
	if !ok || shown >= s.turn {
		return "KYC was not approved. First show the customer all of their current details for this " +
			"account opening (get_current_client_info) and ask whether they are correct. Approve KYC " +
			"only after the customer confirms in their next message.", nil
	}
	if err := toolActivity(ctx, activities.ApproveKYC, ToolTimeout, nil, in.WorkflowID); err != nil {
		return "", err
	}
	return "KYC approved. The account is now waiting for compliance review.", nil
}

func (s *chat) updateClientDetails(ctx agent.Context, in updateClientArgs) (string, error) {
	fields := map[string]any{}
	for name, v := range map[string]string{
		"first_name": in.FirstName, "last_name": in.LastName, "address": in.Address,
		"phone": in.Phone, "email": in.Email, "marital_status": in.MaritalStatus,
	} {
		if v != "" {
			fields[name] = v
		}
	}
	var result string
	err := toolActivity(ctx, activities.UpdateClientDetails, ToolTimeout, &result, in.WorkflowID, fields)
	return result, err
}
