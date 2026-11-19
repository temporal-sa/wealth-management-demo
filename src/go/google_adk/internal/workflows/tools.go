package workflows

import (
	"fmt"

	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/functiontool"
)

// Tool arguments. The model sees the field names and descriptions.

type clientIDArgs struct {
	ClientID string `json:"client_id" jsonschema:"The client's unique identifier."`
}

type addBeneficiaryArgs struct {
	ClientID     string `json:"client_id" jsonschema:"The client's unique identifier."`
	FirstName    string `json:"first_name" jsonschema:"The beneficiary's first name."`
	LastName     string `json:"last_name" jsonschema:"The beneficiary's last name."`
	Relationship string `json:"relationship" jsonschema:"The beneficiary's relationship to the client, e.g. spouse, son, daughter."`
}

type deleteBeneficiaryArgs struct {
	ClientID      string `json:"client_id" jsonschema:"The client's unique identifier."`
	BeneficiaryID string `json:"beneficiary_id" jsonschema:"The ID of the beneficiary to delete, from list_beneficiaries."`
}

type closeInvestmentArgs struct {
	ClientID     string `json:"client_id" jsonschema:"The client's unique identifier."`
	InvestmentID string `json:"investment_id" jsonschema:"The ID of the investment account to close, from list_investments."`
}

type openAccountArgs struct {
	ClientID      string  `json:"client_id" jsonschema:"The client's unique identifier."`
	AccountName   string  `json:"account_name" jsonschema:"The name for the new investment account."`
	InitialAmount float64 `json:"initial_amount" jsonschema:"The initial deposit amount, in dollars."`
}

type workflowIDArgs struct {
	WorkflowID string `json:"workflow_id" jsonschema:"The workflow ID returned by open_new_investment_account."`
}

type updateClientArgs struct {
	WorkflowID    string `json:"workflow_id" jsonschema:"The workflow ID returned by open_new_investment_account."`
	FirstName     string `json:"first_name,omitempty" jsonschema:"Updated first name (omit to leave unchanged)."`
	LastName      string `json:"last_name,omitempty" jsonschema:"Updated last name (omit to leave unchanged)."`
	Address       string `json:"address,omitempty" jsonschema:"Updated address (omit to leave unchanged)."`
	Phone         string `json:"phone,omitempty" jsonschema:"Updated phone number (omit to leave unchanged)."`
	Email         string `json:"email,omitempty" jsonschema:"Updated email address (omit to leave unchanged)."`
	MaritalStatus string `json:"marital_status,omitempty" jsonschema:"Updated marital status (omit to leave unchanged)."`
}

// mustTool builds a function tool. Tools run in the workflow; those that do I/O call
// activities. Building one only fails on a programming error, so it panics.
func mustTool[A, R any](name, description string, fn functiontool.Func[A, R]) tool.Tool {
	t, err := functiontool.New(functiontool.Config{Name: name, Description: description}, fn)
	if err != nil {
		panic(fmt.Sprintf("tool %s: %v", name, err))
	}
	return t
}
