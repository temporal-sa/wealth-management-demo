// Package domain holds the payloads that cross Temporal boundaries (signals, queries,
// updates, activity arguments and results) and the Redis event stream.
//
// The JSON field names are part of the shared Temporal contract: the scripts, the
// shared web front end and the other ports' workers depend on them, so they stay
// snake_case.
package domain

// ProcessUserMessageInput is the payload of the chat workflow's process_user_message signal.
type ProcessUserMessageInput struct {
	UserInput string `json:"user_input"`
}

// ChatInteraction is one turn of the conversation: the customer's message and the agents' reply.
// It is returned by the get_chat_history query and stored in the Redis event stream.
type ChatInteraction struct {
	UserPrompt   string `json:"user_prompt"`
	TextResponse string `json:"text_response"`
	JSONResponse string `json:"json_response"`
	AgentTrace   string `json:"agent_trace"`
}

// StatusUpdate is an account-opening status change, stored in the Redis event stream.
type StatusUpdate struct {
	Status string `json:"status"`
}

// UpdateAccountOpeningStateInput is the payload of the chat workflow's
// update_account_opening_state signal, sent by each open-account child workflow.
type UpdateAccountOpeningStateInput struct {
	AccountName string `json:"account_name"`
	State       string `json:"state"`
	// The open-account workflow that reported the state. Optional so that senders
	// that don't set it keep working.
	WorkflowID *string `json:"workflow_id"`
}

// OpenInvestmentAccountInput is the input of OpenInvestmentAccountWorkflow.
type OpenInvestmentAccountInput struct {
	ClientID      string  `json:"client_id"`
	AccountName   string  `json:"account_name"`
	InitialAmount float64 `json:"initial_amount"`
	// Set when a promotion is running for the new account (e.g. "WELCOME-BONUS").
	PromoCode *string `json:"promo_code"`
}

// OpenInvestmentAccountOutput is the result of OpenInvestmentAccountWorkflow.
type OpenInvestmentAccountOutput struct {
	AccountCreated bool   `json:"account_created"`
	Message        string `json:"message"`
}

// WealthManagementClient is a customer's details, shown to them for KYC.
type WealthManagementClient struct {
	FirstName     string `json:"first_name"`
	LastName      string `json:"last_name"`
	Address       string `json:"address"`
	Phone         string `json:"phone"`
	Email         string `json:"email"`
	MaritalStatus string `json:"marital_status"`
}

// ClientFields lists the client fields the customer can change, in display order.
var ClientFields = []string{"first_name", "last_name", "address", "phone", "email", "marital_status"}

// Field returns the value of a client field by its JSON name.
func (c *WealthManagementClient) Field(name string) string {
	switch name {
	case "first_name":
		return c.FirstName
	case "last_name":
		return c.LastName
	case "address":
		return c.Address
	case "phone":
		return c.Phone
	case "email":
		return c.Email
	case "marital_status":
		return c.MaritalStatus
	}
	return ""
}

// SetField sets a client field by its JSON name. It reports whether the name is a client field.
func (c *WealthManagementClient) SetField(name, value string) bool {
	switch name {
	case "first_name":
		c.FirstName = value
	case "last_name":
		c.LastName = value
	case "address":
		c.Address = value
	case "phone":
		c.Phone = value
	case "email":
		c.Email = value
	case "marital_status":
		c.MaritalStatus = value
	default:
		return false
	}
	return true
}

// Beneficiary is the argument of the add_beneficiary activity.
type Beneficiary struct {
	ClientID     string `json:"client_id"`
	FirstName    string `json:"first_name"`
	LastName     string `json:"last_name"`
	Relationship string `json:"relationship"`
}

// BeneficiaryRecord is a stored beneficiary, as list_beneficiaries returns it.
type BeneficiaryRecord struct {
	BeneficiaryID string `json:"beneficiary_id"`
	FirstName     string `json:"first_name"`
	LastName      string `json:"last_name"`
	Relationship  string `json:"relationship"`
}

// InvestmentAccount is the argument of the open_investment activity.
type InvestmentAccount struct {
	ClientID string  `json:"client_id"`
	Name     string  `json:"name"`
	Balance  float64 `json:"balance"`
}

// InvestmentRecord is a stored investment account, as list_investments and open_investment return it.
type InvestmentRecord struct {
	InvestmentID string  `json:"investment_id"`
	Name         string  `json:"name"`
	Balance      float64 `json:"balance"`
}

// Transfer is a movement of money to or from a linked bank account.
type Transfer struct {
	ClientID     string  `json:"client_id"`
	Amount       float64 `json:"amount"`
	BalanceAfter float64 `json:"balance_after"`
}

// Event types in the Redis event stream the web front end polls.
const (
	EventChatInteraction = "chat_interaction"
	EventStatusUpdate    = "status_update"
)

// Event is one entry of the Redis event stream: {type, content}.
type Event struct {
	Type    string `json:"type"`
	Content any    `json:"content"`
}
