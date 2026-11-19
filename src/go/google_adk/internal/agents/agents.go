// Package agents builds the demo's ADK agent tree, shared by the Temporal and standalone
// versions. Each version supplies its own models and tools.
//
// The tree is
//
//	Supervisor_Agent
//	├── Beneficiary_Agent              (transfers back to the supervisor only)
//	└── Investment_Agent               (transfers back to the supervisor, or down to Open_Account_Agent)
//	    └── Open_Account_Agent         (Temporal version only; transfers back to Investment_Agent)
//
// ADK hands off between agents with its built-in transfer_to_agent tool, inside one turn.
package agents

import (
	"strconv"

	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/agent/llmagent"
	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/tool"

	"github.com/temporal-sa/adk-go-wealth-management/internal/prompts"
)

// Options is what a version supplies to build the tree.
type Options struct {
	// Model returns the model an agent uses, by agent name.
	Model func(agentName string) model.LLM
	// ClientID returns the customer's client ID once a tool has used it, or "".
	// Every agent's instructions include it from then on.
	ClientID func() string
	// RememberClientID is called with each tool call's client_id argument, before the tool runs.
	RememberClientID func(clientID string)

	BeneficiaryTools []tool.Tool
	InvestmentTools  []tool.Tool
	// OpenAccountTools, when set, adds the Open Account Agent under the Investment Agent.
	OpenAccountTools []tool.Tool
	// InvestmentInstructions is the Investment Agent's instructions (they differ in the
	// standalone version, which opens accounts directly).
	InvestmentInstructions string
}

// Build returns the root (supervisor) agent.
func Build(o Options) (agent.Agent, error) {
	newAgent := func(name, description, instructions string, tools []tool.Tool, subAgents []agent.Agent, noPeers bool) (agent.Agent, error) {
		return llmagent.New(llmagent.Config{
			Name:        name,
			Description: description,
			Model:       o.Model(name),
			InstructionProvider: func(agent.ReadonlyContext) (string, error) {
				return prompts.WithClientID(instructions, o.ClientID()), nil
			},
			Tools:     tools,
			SubAgents: subAgents,
			// Match the reference's handoffs: a specialist goes back up, not sideways.
			DisallowTransferToPeers: noPeers,
			BeforeToolCallbacks:     []llmagent.BeforeToolCallback{o.rememberClientID},
		})
	}

	var investmentSubAgents []agent.Agent
	if o.OpenAccountTools != nil {
		openAccount, err := newAgent(prompts.OpenAccountAgentName, prompts.OpenAccountDescription,
			prompts.OpenAccountInstructions, o.OpenAccountTools, nil, false)
		if err != nil {
			return nil, err
		}
		investmentSubAgents = append(investmentSubAgents, openAccount)
	}
	investment, err := newAgent(prompts.InvestmentAgentName, prompts.InvestmentDescription,
		o.InvestmentInstructions, o.InvestmentTools, investmentSubAgents, true)
	if err != nil {
		return nil, err
	}
	beneficiary, err := newAgent(prompts.BeneficiaryAgentName, prompts.BeneficiaryDescription,
		prompts.BeneficiaryInstructions, o.BeneficiaryTools, nil, true)
	if err != nil {
		return nil, err
	}
	return newAgent(prompts.SupervisorAgentName, prompts.SupervisorDescription,
		prompts.SupervisorInstructions, nil, []agent.Agent{beneficiary, investment}, false)
}

// rememberClientID is every agent's before-tool callback: it saves the client ID the
// first time a tool is called with one, so no agent asks for it again.
func (o Options) rememberClientID(_ agent.Context, _ tool.Tool, args map[string]any) (map[string]any, error) {
	if id, ok := args["client_id"]; ok && o.RememberClientID != nil {
		if s := toString(id); s != "" {
			o.RememberClientID(s)
		}
	}
	return nil, nil
}

func toString(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case float64:
		if t == float64(int64(t)) {
			return strconv.FormatInt(int64(t), 10)
		}
	}
	return ""
}
