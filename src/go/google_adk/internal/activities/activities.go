// Package activities holds the demo's Temporal activities, registered under the
// snake_case names of the shared Temporal contract (see Names). The other ports' scripts
// and the Java open-account worker call them by these names.
package activities

import (
	"context"
	"errors"
	"fmt"

	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/worker"

	"github.com/temporal-sa/adk-go-wealth-management/internal/chaos"
	"github.com/temporal-sa/adk-go-wealth-management/internal/data"
	"github.com/temporal-sa/adk-go-wealth-management/internal/domain"
	"github.com/temporal-sa/adk-go-wealth-management/internal/eventstream"
)

// Activity names (the shared Temporal contract).
const (
	ListBeneficiaries     = "list_beneficiaries"
	AddBeneficiary        = "add_beneficiary"
	DeleteBeneficiary     = "delete_beneficiary"
	ListInvestments       = "list_investments"
	CloseInvestment       = "close_investment"
	ValidateNewAccount    = "validate_new_account"
	FindPromotion         = "find_promotion"
	OpenInvestment        = "open_investment"
	RemoveInvestment      = "remove_investment"
	GetClient             = "get_client"
	UpdateClient          = "update_client"
	DebitLinkedAccount    = "debit_linked_account"
	CreditLinkedAccount   = "credit_linked_account"
	RegisterAccount       = "register_account"
	GetCurrentClientInfo  = "get_current_client_info"
	ApproveKYC            = "approve_kyc"
	UpdateClientDetails   = "update_client_details"
	AppendChatInteraction = "append_chat_interaction"
	AppendStatusUpdate    = "append_status_update"
	DeleteConversation    = "delete_conversation"
)

// Business-failure error types (non-retryable ApplicationErrors).
const (
	ErrDepositBelowMinimum  = "DepositBelowMinimum"
	ErrDepositLimitExceeded = "DepositLimitExceeded"
	ErrInsufficientFunds    = "InsufficientFunds"
	ErrCustodianRejected    = "CustodianRejected"
)

// Business rules for a new account.
const (
	MinInitialDeposit = 100.0
	MaxInitialDeposit = 1_000_000.0
	WelcomeBonusPromo = "WELCOME-BONUS"
)

// Names of the open-account workflow's handlers, which the chat-side activities call.
const (
	OpenAccountGetClientDetails    = "get_client_details"
	OpenAccountUpdateClientDetails = "update_client_details"
	OpenAccountVerifyKYC           = "verify_kyc"
)

// Activities implements every activity. Build one per worker.
type Activities struct {
	Data   *data.Store
	Chaos  chaos.Source
	Events eventstream.Stream
	// Client signals and updates open-account workflows (get_current_client_info,
	// approve_kyc and update_client_details).
	Client client.Client
}

// Register registers every activity on a worker under its contract name.
func (a *Activities) Register(r worker.ActivityRegistry) {
	for name, fn := range map[string]any{
		ListBeneficiaries:     a.ListBeneficiaries,
		AddBeneficiary:        a.AddBeneficiary,
		DeleteBeneficiary:     a.DeleteBeneficiary,
		ListInvestments:       a.ListInvestments,
		CloseInvestment:       a.CloseInvestment,
		ValidateNewAccount:    a.ValidateNewAccount,
		FindPromotion:         a.FindPromotion,
		OpenInvestment:        a.OpenInvestment,
		RemoveInvestment:      a.RemoveInvestment,
		GetClient:             a.GetClient,
		UpdateClient:          a.UpdateClient,
		DebitLinkedAccount:    a.DebitLinkedAccount,
		CreditLinkedAccount:   a.CreditLinkedAccount,
		RegisterAccount:       a.RegisterAccount,
		GetCurrentClientInfo:  a.GetCurrentClientInfo,
		ApproveKYC:            a.ApproveKYC,
		UpdateClientDetails:   a.UpdateClientDetails,
		AppendChatInteraction: a.AppendChatInteraction,
		AppendStatusUpdate:    a.AppendStatusUpdate,
		DeleteConversation:    a.DeleteConversation,
	} {
		r.RegisterActivityWithOptions(fn, activity.RegisterOptions{Name: name})
	}
}

// ---------------------------------------------------------------------------
// Beneficiaries
// ---------------------------------------------------------------------------

func (a *Activities) ListBeneficiaries(ctx context.Context, clientID string) ([]domain.BeneficiaryRecord, error) {
	activity.GetLogger(ctx).Info("list_beneficiaries", "client_id", clientID)
	if err := chaos.CoreBankingAPI(ctx, a.Chaos); err != nil {
		return nil, err
	}
	return a.Data.ListBeneficiaries(clientID)
}

func (a *Activities) AddBeneficiary(ctx context.Context, b domain.Beneficiary) error {
	activity.GetLogger(ctx).Info("add_beneficiary", "client_id", b.ClientID, "first_name", b.FirstName, "last_name", b.LastName)
	if err := chaos.CoreBankingAPI(ctx, a.Chaos); err != nil {
		return err
	}
	_, err := a.Data.AddBeneficiary(b)
	return err
}

func (a *Activities) DeleteBeneficiary(ctx context.Context, clientID, beneficiaryID string) error {
	activity.GetLogger(ctx).Info("delete_beneficiary", "client_id", clientID, "beneficiary_id", beneficiaryID)
	if err := chaos.CoreBankingAPI(ctx, a.Chaos); err != nil {
		return err
	}
	_, err := a.Data.DeleteBeneficiary(clientID, beneficiaryID)
	return err
}

// ---------------------------------------------------------------------------
// Investments
// ---------------------------------------------------------------------------

func (a *Activities) ListInvestments(ctx context.Context, clientID string) ([]domain.InvestmentRecord, error) {
	activity.GetLogger(ctx).Info("list_investments", "client_id", clientID)
	if err := chaos.CoreBankingAPI(ctx, a.Chaos); err != nil {
		return nil, err
	}
	return a.Data.ListInvestments(clientID)
}

func (a *Activities) CloseInvestment(ctx context.Context, clientID, investmentID string) error {
	activity.GetLogger(ctx).Info("close_investment", "client_id", clientID, "investment_id", investmentID)
	if err := chaos.CoreBankingAPI(ctx, a.Chaos); err != nil {
		return err
	}
	_, err := a.Data.DeleteInvestment(clientID, investmentID)
	return err
}

// ValidateNewAccount checks the business rules for opening an account. A broken rule is a
// non-retryable error, so it fails on the first attempt.
func (a *Activities) ValidateNewAccount(ctx context.Context, clientID, accountName string, initialAmount float64) error {
	activity.GetLogger(ctx).Info("validate_new_account", "client_id", clientID, "account_name", accountName, "initial_amount", initialAmount)
	return CheckDeposit(initialAmount)
}

// CheckDeposit applies the deposit rules: from $100 to $1,000,000.
func CheckDeposit(initialAmount float64) error {
	if initialAmount < MinInitialDeposit {
		return temporal.NewNonRetryableApplicationError(
			fmt.Sprintf("The initial deposit must be at least %s", data.Money(MinInitialDeposit)),
			ErrDepositBelowMinimum, nil)
	}
	if initialAmount > MaxInitialDeposit {
		return temporal.NewNonRetryableApplicationError(
			fmt.Sprintf("Initial deposits over %s cannot be opened online and must be arranged with a wealth advisor",
				data.Money(MaxInitialDeposit)),
			ErrDepositLimitExceeded, nil)
	}
	return nil
}

// FindPromotion returns the promo code for a new account, if a promotion is running. The
// chaos panel's "Bug in workflow code" switch runs the welcome-bonus promotion, whose code
// path in OpenInvestmentAccountWorkflow has a bug.
func (a *Activities) FindPromotion(ctx context.Context, clientID string) (*string, error) {
	activity.GetLogger(ctx).Info("find_promotion", "client_id", clientID)
	if a.Chaos.IsEnabled(ctx, chaos.WorkflowBug) {
		code := WelcomeBonusPromo
		return &code, nil
	}
	return nil, nil
}

func (a *Activities) OpenInvestment(ctx context.Context, account domain.InvestmentAccount) (domain.InvestmentRecord, error) {
	activity.GetLogger(ctx).Info("open_investment", "client_id", account.ClientID, "name", account.Name, "balance", account.Balance)
	chaos.MaybeSlowDown(ctx, a.Chaos)
	if err := chaos.CoreBankingAPI(ctx, a.Chaos); err != nil {
		return domain.InvestmentRecord{}, err
	}
	return a.Data.AddInvestment(account)
}

// RemoveInvestment removes an investment account record: the saga's compensation for
// open_investment. An account that is already gone counts as removed, so a retried
// compensation succeeds.
func (a *Activities) RemoveInvestment(ctx context.Context, clientID, investmentID string) (bool, error) {
	activity.GetLogger(ctx).Info("remove_investment", "client_id", clientID, "investment_id", investmentID)
	chaos.MaybeSlowDown(ctx, a.Chaos)
	if err := chaos.CoreBankingAPI(ctx, a.Chaos); err != nil {
		return false, err
	}
	if _, err := a.Data.DeleteInvestment(clientID, investmentID); err != nil {
		return false, err
	}
	return true, nil
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

func (a *Activities) GetClient(ctx context.Context, clientID string) (*domain.WealthManagementClient, error) {
	activity.GetLogger(ctx).Info("get_client", "client_id", clientID)
	return a.Data.GetClient(clientID)
}

func (a *Activities) UpdateClient(ctx context.Context, clientID string, fields map[string]any) (string, error) {
	activity.GetLogger(ctx).Info("update_client", "client_id", clientID, "fields", fields)
	return a.Data.UpdateClient(clientID, fields)
}

// ---------------------------------------------------------------------------
// Funding: each call carries a transfer ID that is stable across retries, so a retried
// activity never moves the money twice.
// ---------------------------------------------------------------------------

func (a *Activities) DebitLinkedAccount(ctx context.Context, clientID string, amount float64, transferID string) (domain.Transfer, error) {
	activity.GetLogger(ctx).Info("debit_linked_account", "client_id", clientID, "amount", amount, "transfer_id", transferID)
	chaos.MaybeSlowDown(ctx, a.Chaos)
	t, err := a.Data.Debit(clientID, amount, transferID)
	if errors.Is(err, data.ErrInsufficientFunds) {
		// A business-rule failure: retrying won't make the money appear.
		msg := err.Error()
		if _, after, ok := cutPrefix(msg, data.ErrInsufficientFunds.Error()+": "); ok {
			msg = after
		}
		return domain.Transfer{}, temporal.NewNonRetryableApplicationError(msg, ErrInsufficientFunds, nil)
	}
	return t, err
}

// CreditLinkedAccount refunds money to the linked bank account: the saga's compensation
// for debit_linked_account.
func (a *Activities) CreditLinkedAccount(ctx context.Context, clientID string, amount float64, transferID string) (domain.Transfer, error) {
	activity.GetLogger(ctx).Info("credit_linked_account", "client_id", clientID, "amount", amount, "transfer_id", transferID)
	chaos.MaybeSlowDown(ctx, a.Chaos)
	return a.Data.Credit(clientID, amount, transferID)
}

// ---------------------------------------------------------------------------
// Custodian: the third party that holds a new account's assets
// ---------------------------------------------------------------------------

// RegisterAccount registers a new investment account with the custodian and returns its reference.
func (a *Activities) RegisterAccount(ctx context.Context, clientID, investmentID string, amount float64) (string, error) {
	activity.GetLogger(ctx).Info("register_account", "client_id", clientID, "investment_id", investmentID, "amount", amount)
	chaos.MaybeSlowDown(ctx, a.Chaos)
	if err := chaos.Inject(ctx, a.Chaos, chaos.CustodianRejects, temporal.NewNonRetryableApplicationError(
		"The custodian rejected the account registration", ErrCustodianRejected, nil)); err != nil {
		return "", err
	}
	return "CUST-" + investmentID, nil
}

// ---------------------------------------------------------------------------
// Open account, chat side: these reach the open-account workflow through the Temporal client
// ---------------------------------------------------------------------------

// GetCurrentClientInfo runs the open-account workflow's get_client_details update.
func (a *Activities) GetCurrentClientInfo(ctx context.Context, workflowID string) (domain.WealthManagementClient, error) {
	var c domain.WealthManagementClient
	h, err := a.Client.UpdateWorkflow(ctx, client.UpdateWorkflowOptions{
		WorkflowID:   workflowID,
		UpdateName:   OpenAccountGetClientDetails,
		WaitForStage: client.WorkflowUpdateStageCompleted,
	})
	if err != nil {
		return c, err
	}
	return c, h.Get(ctx, &c)
}

// ApproveKYC sends the open-account workflow's verify_kyc signal.
func (a *Activities) ApproveKYC(ctx context.Context, workflowID string) error {
	return a.Client.SignalWorkflow(ctx, workflowID, "", OpenAccountVerifyKYC, nil)
}

// UpdateClientDetails runs the open-account workflow's update_client_details update with
// the changed fields. It completes KYC.
func (a *Activities) UpdateClientDetails(ctx context.Context, workflowID string, fields map[string]any) (string, error) {
	h, err := a.Client.UpdateWorkflow(ctx, client.UpdateWorkflowOptions{
		WorkflowID:   workflowID,
		UpdateName:   OpenAccountUpdateClientDetails,
		Args:         []any{fields},
		WaitForStage: client.WorkflowUpdateStageCompleted,
	})
	if err != nil {
		return "", err
	}
	var result string
	return result, h.Get(ctx, &result)
}

// ---------------------------------------------------------------------------
// Event stream
// ---------------------------------------------------------------------------

func (a *Activities) AppendChatInteraction(ctx context.Context, workflowID string, ci domain.ChatInteraction) (int64, error) {
	return a.Events.Append(ctx, workflowID, domain.Event{Type: domain.EventChatInteraction, Content: ci})
}

func (a *Activities) AppendStatusUpdate(ctx context.Context, workflowID string, su domain.StatusUpdate) (int64, error) {
	return a.Events.Append(ctx, workflowID, domain.Event{Type: domain.EventStatusUpdate, Content: su})
}

func (a *Activities) DeleteConversation(ctx context.Context, workflowID string) (bool, error) {
	return a.Events.Delete(ctx, workflowID)
}

func cutPrefix(s, prefix string) (string, string, bool) {
	if len(s) >= len(prefix) && s[:len(prefix)] == prefix {
		return prefix, s[len(prefix):], true
	}
	return "", s, false
}
