// Package standalone is the demo with Google ADK alone, no Temporal: the same agents, run
// in process. It opens accounts directly with a tool: there is no KYC, compliance review
// or saga, and nothing survives a crash.
package standalone

import (
	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/functiontool"

	"github.com/temporal-sa/adk-go-wealth-management/internal/agents"
	"github.com/temporal-sa/adk-go-wealth-management/internal/data"
	"github.com/temporal-sa/adk-go-wealth-management/internal/domain"
	"github.com/temporal-sa/adk-go-wealth-management/internal/prompts"
)

// Build returns the standalone version's root agent. Every agent uses m.
func Build(m model.LLM, store *data.Store) (agent.Agent, error) {
	var clientID string
	return agents.Build(agents.Options{
		Model:                  func(string) model.LLM { return m },
		ClientID:               func() string { return clientID },
		RememberClientID:       func(id string) { clientID = id },
		BeneficiaryTools:       beneficiaryTools(store),
		InvestmentTools:        investmentTools(store),
		InvestmentInstructions: prompts.StandaloneInvestmentInstructions,
	})
}

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

type openInvestmentArgs struct {
	ClientID       string  `json:"client_id" jsonschema:"The client's unique identifier."`
	AccountName    string  `json:"account_name" jsonschema:"The name for the new investment account."`
	InitialBalance float64 `json:"initial_balance" jsonschema:"The initial deposit, in dollars."`
}

type closeInvestmentArgs struct {
	ClientID     string `json:"client_id" jsonschema:"The client's unique identifier."`
	InvestmentID string `json:"investment_id" jsonschema:"The ID of the investment account to close, from list_investments."`
}

func beneficiaryTools(store *data.Store) []tool.Tool {
	return []tool.Tool{
		mustTool("list_beneficiaries", "List a client's beneficiaries.",
			func(_ agent.Context, in clientIDArgs) ([]domain.BeneficiaryRecord, error) {
				return store.ListBeneficiaries(in.ClientID)
			}),
		mustTool("add_beneficiary", "Add a new beneficiary for a client.",
			func(_ agent.Context, in addBeneficiaryArgs) (string, error) {
				_, err := store.AddBeneficiary(domain.Beneficiary(in))
				return "Beneficiary added.", err
			}),
		mustTool("delete_beneficiary", "Delete a client's beneficiary by its beneficiary ID.",
			func(_ agent.Context, in deleteBeneficiaryArgs) (string, error) {
				_, err := store.DeleteBeneficiary(in.ClientID, in.BeneficiaryID)
				return "Beneficiary deleted.", err
			}),
	}
}

func investmentTools(store *data.Store) []tool.Tool {
	return []tool.Tool{
		mustTool("list_investments", "List a client's investment accounts and their balances.",
			func(_ agent.Context, in clientIDArgs) ([]domain.InvestmentRecord, error) {
				return store.ListInvestments(in.ClientID)
			}),
		mustTool("open_investment", "Open a new investment account for a client, with an initial deposit.",
			func(_ agent.Context, in openInvestmentArgs) (domain.InvestmentRecord, error) {
				return store.AddInvestment(domain.InvestmentAccount{ClientID: in.ClientID, Name: in.AccountName, Balance: in.InitialBalance})
			}),
		mustTool("close_investment", "Close a client's investment account by its investment ID.",
			func(_ agent.Context, in closeInvestmentArgs) (string, error) {
				_, err := store.DeleteInvestment(in.ClientID, in.InvestmentID)
				return "Investment account closed.", err
			}),
	}
}

func mustTool[A, R any](name, description string, fn functiontool.Func[A, R]) tool.Tool {
	t, err := functiontool.New(functiontool.Config{Name: name, Description: description}, fn)
	if err != nil {
		panic(err)
	}
	return t
}
