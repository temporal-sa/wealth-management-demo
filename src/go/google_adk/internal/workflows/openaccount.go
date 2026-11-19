package workflows

import (
	"errors"
	"fmt"
	"math"

	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"

	"github.com/temporal-sa/adk-go-wealth-management/internal/activities"
	"github.com/temporal-sa/adk-go-wealth-management/internal/data"
	"github.com/temporal-sa/adk-go-wealth-management/internal/domain"
)

// Names of OpenInvestmentAccountWorkflow and its handlers (the shared Temporal contract).
const (
	OpenInvestmentAccountWorkflowName = "OpenInvestmentAccountWorkflow"
	QueryGetCurrentState              = "get_current_state"
	UpdateGetClientDetails            = activities.OpenAccountGetClientDetails
	UpdateUpdateClientDetails         = activities.OpenAccountUpdateClientDetails
	SignalVerifyKYC                   = activities.OpenAccountVerifyKYC
	SignalComplianceApproved          = "compliance_approved"
)

// Account-opening states, reported to the parent chat workflow.
const (
	StateInitializing       = "Initializing"
	StateWaitingKYC         = "Waiting KYC"
	StateWaitingCompliance  = "Waiting Compliance Review"
	StateComplianceApproved = "Compliance review has been approved. Creating Investment Account"
	StateCreatingRecord     = "Creating the account record."
	StateRegistering        = "Registering the account with the custodian."
	StateComplete           = "Complete"
)

// openAccount is one run of OpenInvestmentAccountWorkflow.
type openAccount struct {
	input              domain.OpenInvestmentAccountInput
	client             *domain.WealthManagementClient
	initialized        bool
	kycVerified        bool
	complianceReviewed bool
	currentState       string
}

// OpenInvestmentAccountWorkflow opens an investment account: it waits for the customer's
// KYC confirmation and a compliance officer's approval, then runs a saga that creates,
// funds and registers the account, undoing the completed steps if one fails.
func OpenInvestmentAccountWorkflow(ctx workflow.Context, input domain.OpenInvestmentAccountInput) (domain.OpenInvestmentAccountOutput, error) {
	logger := workflow.GetLogger(ctx)
	logger.Info("Started open-account workflow", "input", input)
	w := &openAccount{input: input, currentState: StateInitializing}
	if err := w.registerHandlers(ctx); err != nil {
		return domain.OpenInvestmentAccountOutput{}, err
	}

	if err := w.execute(ctx, activities.GetClient, &w.client, input.ClientID); err != nil {
		return domain.OpenInvestmentAccountOutput{}, err
	}
	w.initialized = true
	w.setState(ctx, StateWaitingKYC)

	// Wait until the customer has confirmed their details are correct.
	if err := workflow.Await(ctx, func() bool { return w.kycVerified }); err != nil {
		return domain.OpenInvestmentAccountOutput{}, err
	}
	w.setState(ctx, StateWaitingCompliance)

	// Wait for a compliance officer's approval, sent from outside the chat.
	if err := workflow.Await(ctx, func() bool { return w.complianceReviewed }); err != nil {
		return domain.OpenInvestmentAccountOutput{}, err
	}
	w.setState(ctx, StateComplianceApproved)
	return w.openAccount(ctx)
}

// compensation undoes one completed saga step.
type compensation struct {
	description string
	activity    string
	args        []any
}

// openAccount is the saga: create, fund and register the account. Each completed step
// records how to undo it. If a later step fails with a non-retryable error, the recorded
// compensations run in reverse order. Transient failures never get here: the activities
// retry until they succeed.
func (w *openAccount) openAccount(ctx workflow.Context) (domain.OpenInvestmentAccountOutput, error) {
	in := w.input
	amount := in.InitialAmount
	bonus := 0.0
	if in.PromoCode != nil {
		bonus = welcomeBonus(in)
	}
	// Idempotency key: stable across activity retries and worker restarts. The chat gives
	// every account opening its own workflow ID, and the run ID keeps a transfer from
	// repeating when a workflow ID is started again by hand.
	info := workflow.GetInfo(ctx)
	transferID := fmt.Sprintf("%s-%s-initial-deposit", info.WorkflowExecution.ID, info.WorkflowExecution.RunID)

	var compensations []compensation
	err := func() error {
		w.setState(ctx, StateCreatingRecord)
		var account domain.InvestmentRecord
		if err := w.execute(ctx, activities.OpenInvestment, &account,
			domain.InvestmentAccount{ClientID: in.ClientID, Name: in.AccountName, Balance: amount + bonus}); err != nil {
			return err
		}
		compensations = append(compensations, compensation{
			"removing the account record", activities.RemoveInvestment, []any{in.ClientID, account.InvestmentID}})

		w.setState(ctx, fmt.Sprintf("Transferring %s from the linked bank account.", data.Money(amount)))
		if err := w.execute(ctx, activities.DebitLinkedAccount, nil, in.ClientID, amount, transferID); err != nil {
			return err
		}
		compensations = append(compensations, compensation{
			fmt.Sprintf("refunding %s to the linked bank account", data.Money(amount)),
			activities.CreditLinkedAccount, []any{in.ClientID, amount, transferID + "-refund"}})

		w.setState(ctx, StateRegistering)
		return w.execute(ctx, activities.RegisterAccount, nil, in.ClientID, account.InvestmentID, amount)
	}()
	if err != nil {
		reason := failureReason(err)
		w.setState(ctx, fmt.Sprintf("Failed: %s. Rolling back.", reason))
		for i := len(compensations) - 1; i >= 0; i-- {
			c := compensations[i]
			w.setState(ctx, fmt.Sprintf("Rolling back: %s.", c.description))
			// Compensations retry until they succeed.
			if cerr := w.execute(ctx, c.activity, nil, c.args...); cerr != nil {
				return domain.OpenInvestmentAccountOutput{}, cerr
			}
		}
		w.setState(ctx, fmt.Sprintf("Rolled back. The account was not opened: %s.", reason))
		return domain.OpenInvestmentAccountOutput{AccountCreated: false, Message: "The account was not opened: " + reason}, nil
	}

	w.setState(ctx, StateComplete)
	return domain.OpenInvestmentAccountOutput{AccountCreated: true, Message: "investment account created"}, nil
}

// promotion is a promo code's bonus: a share of the initial deposit, up to a cap.
type promotion struct {
	rate float64
	max  float64
}

// promotions holds each running promotion, keyed by its promo code.
var promotions = map[string]*promotion{
	activities.WelcomeBonusPromo: {rate: 0.01, max: 500},
}

// welcomeBonus is the welcome-bonus promotion: 1% of the initial deposit, up to $500.
func welcomeBonus(in domain.OpenInvestmentAccountInput) float64 {
	// *** Bug-In-Workflow-Code ***
	// Intentional bug for the "Bug in workflow code" demo: the promo code is WELCOME-BONUS,
	// but the line below looks it up as WELCOME_BONUS, finds nothing, and dereferences a nil
	// pointer. The panic fails the workflow task, not the workflow, so the workflow stays
	// Running and keeps its compliance approval. To fix it, uncomment the first line below
	// and comment out the second, then restart the worker. See README "Failure scenarios".
	// promo := promotions[*in.PromoCode]
	promo := promotions["WELCOME_BONUS"]
	return math.Min(in.InitialAmount*promo.rate, promo.max)
}

// failureReason is the business reason a saga step failed: an ApplicationError's message.
func failureReason(err error) string {
	var appErr *temporal.ApplicationError
	if errors.As(err, &appErr) {
		return appErr.Message()
	}
	return err.Error()
}

// execute runs a tool activity with the tool retry policy, and decodes its result into
// result unless result is nil.
func (w *openAccount) execute(ctx workflow.Context, name string, result any, args ...any) error {
	actx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		// Bounds a single attempt only, so an outage is retried for as long as it lasts.
		StartToCloseTimeout: ToolTimeout,
		RetryPolicy:         ToolRetryPolicy,
	})
	f := workflow.ExecuteActivity(actx, name, args...)
	if result == nil {
		return f.Get(ctx, nil)
	}
	return f.Get(ctx, result)
}

// setState records the current state and signals it to the parent chat workflow, if any.
func (w *openAccount) setState(ctx workflow.Context, state string) {
	w.currentState = state
	info := workflow.GetInfo(ctx)
	if info.ParentWorkflowExecution == nil {
		return
	}
	wfID := info.WorkflowExecution.ID
	err := workflow.SignalExternalWorkflow(ctx, info.ParentWorkflowExecution.ID, "", SignalUpdateAccountOpeningState,
		domain.UpdateAccountOpeningStateInput{AccountName: w.input.AccountName, State: state, WorkflowID: &wfID}).Get(ctx, nil)
	if err != nil {
		workflow.GetLogger(ctx).Warn("Could not signal the parent workflow", "state", state, "error", err)
	}
}

func (w *openAccount) registerHandlers(ctx workflow.Context) error {
	if err := workflow.SetQueryHandler(ctx, QueryGetCurrentState, func() (string, error) {
		return w.currentState, nil
	}); err != nil {
		return err
	}

	if err := workflow.SetUpdateHandler(ctx, UpdateGetClientDetails,
		func(ctx workflow.Context) (domain.WealthManagementClient, error) {
			if err := workflow.Await(ctx, func() bool { return w.initialized }); err != nil {
				return domain.WealthManagementClient{}, err
			}
			if w.client == nil {
				return domain.WealthManagementClient{}, fmt.Errorf("client %s not found", w.input.ClientID)
			}
			return *w.client, nil
		}); err != nil {
		return err
	}

	if err := workflow.SetUpdateHandler(ctx, UpdateUpdateClientDetails,
		func(ctx workflow.Context, fields map[string]any) (string, error) {
			var result string
			if err := w.execute(ctx, activities.UpdateClient, &result, w.input.ClientID, fields); err != nil {
				return "", err
			}
			if w.client != nil {
				for name, value := range fields {
					if value != nil {
						w.client.SetField(name, fmt.Sprint(value))
					}
				}
			}
			w.kycVerified = true
			return result, nil
		}); err != nil {
		return err
	}

	// Signals are handled in their own coroutines, so each can wait for its precondition
	// without holding up the workflow.
	verifyKYC := workflow.GetSignalChannel(ctx, SignalVerifyKYC)
	workflow.Go(ctx, func(ctx workflow.Context) {
		for {
			verifyKYC.Receive(ctx, nil)
			workflow.Go(ctx, func(ctx workflow.Context) {
				if workflow.Await(ctx, func() bool { return w.initialized }) == nil {
					workflow.GetLogger(ctx).Info("KYC has been verified")
					w.kycVerified = true
				}
			})
		}
	})
	compliance := workflow.GetSignalChannel(ctx, SignalComplianceApproved)
	workflow.Go(ctx, func(ctx workflow.Context) {
		for {
			compliance.Receive(ctx, nil)
			workflow.Go(ctx, func(ctx workflow.Context) {
				if workflow.Await(ctx, func() bool { return w.initialized && w.kycVerified }) == nil {
					workflow.GetLogger(ctx).Info("Compliance has been approved")
					w.complianceReviewed = true
				}
			})
		}
	})
	return nil
}
