package workflows

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/temporal-sa/adk-go-wealth-management/internal/prompts"
)

const vacation1 = "OpenAccount-" + testChatID + "-123-Vacation-1"
const vacation2 = "OpenAccount-" + testChatID + "-123-Vacation-2"

// TestKYCGuardAndRepeatOpening: two "Vacation" openings in one chat start -Vacation-1 and
// -Vacation-2, and approve_kyc refuses until this opening's details were shown in an
// earlier turn, so the second opening needs its own KYC.
func TestKYCGuardAndRepeatOpening(t *testing.T) {
	details := "Your details: Don Doe, 123 Main Street, 999-555-1212, jd@someplace.com, married. Are these correct?"
	m := newScriptedModel(
		// Turn 1: "Open Vacation with $13,000"
		transfer(prompts.InvestmentAgentName),
		transfer(prompts.OpenAccountAgentName),
		call("open_new_investment_account", map[string]any{"client_id": "123", "account_name": "Vacation", "initial_amount": 13000}),
		call("get_current_client_info", map[string]any{"workflow_id": vacation1}),
		// Approving in the same turn the details were fetched must be refused.
		call("approve_kyc", map[string]any{"workflow_id": vacation1}),
		text(details),
		// Turn 2: "Yes"
		call("approve_kyc", map[string]any{"workflow_id": vacation1}),
		text("KYC approved. Please wait for compliance review."),
		// Turn 3: "Open Vacation with $13,000" again
		call("open_new_investment_account", map[string]any{"client_id": "123", "account_name": "Vacation", "initial_amount": 13000}),
		// The customer confirmed details for the first opening, not this one.
		call("approve_kyc", map[string]any{"workflow_id": vacation2}),
		call("get_current_client_info", map[string]any{"workflow_id": vacation2}),
		text(details),
	)
	ce := newChatEnv(t, m)
	history := ce.run(t, "Open Vacation with $13,000", "Yes", "Open Vacation with $13,000")

	assert.Contains(t, history[0].JSONResponse, vacation1)
	assert.Contains(t, history[0].JSONResponse, "KYC was not approved")
	assert.Contains(t, history[1].JSONResponse, "KYC approved")
	assert.Contains(t, history[2].JSONResponse, vacation2)
	assert.Contains(t, history[2].JSONResponse, "KYC was not approved")
	assert.Equal(t, []string{vacation1}, ce.approved, "only the first opening's KYC is approved")
	assert.Contains(t, history[0].TextResponse, "Don")
}

// TestClientIDSharedAcrossAgents: once a tool has used the client ID, every agent is told
// it, and a handoff happens in the same turn as the request.
func TestClientIDSharedAcrossAgents(t *testing.T) {
	m := newScriptedModel(
		// Turn 1: "Who are my beneficiaries?"
		transfer(prompts.BeneficiaryAgentName),
		text("What is your client ID?"),
		// Turn 2: "123"
		call("list_beneficiaries", map[string]any{"client_id": "123"}),
		text("Your beneficiaries are Junior Doe (son), Juniorette Doe (daughter) and Jane Doe (spouse)."),
		// Turn 3: "What investments do I have?"
		transfer(prompts.SupervisorAgentName),
		transfer(prompts.InvestmentAgentName),
		call("list_investments", map[string]any{"client_id": "123"}),
		text("You have Checking, Savings and 401K accounts."),
	)
	ce := newChatEnv(t, m)
	history := ce.run(t, "Who are my beneficiaries?", "123", "What investments do I have?")

	instructions := m.systemInstructions()
	require.Len(t, instructions, 8)
	const told = "The customer's client ID is 123."
	for i, si := range instructions {
		if i < 3 {
			assert.NotContains(t, si, told, "request %d comes before any tool used the client ID", i)
		} else {
			assert.Contains(t, si, told, "request %d", i)
		}
	}
	// Requests 4, 5 and 6 are the Beneficiary, Supervisor and Investment agents.
	assert.Contains(t, instructions[4], "You are a beneficiary agent")
	assert.Contains(t, instructions[5], "wealth management assistant")
	assert.Contains(t, instructions[6], "You are an investment agent")

	trace := history[2].AgentTrace
	assert.Contains(t, trace, "Handed off from Beneficiary_Agent to Supervisor_Agent")
	assert.Contains(t, trace, "Handed off from Supervisor_Agent to Investment_Agent")
	assert.Contains(t, history[2].JSONResponse, "401K")
	assert.False(t, strings.Contains(strings.ToLower(history[2].TextResponse), "transfer"))
}

// TestBusinessRuleRefusal: a deposit over $1,000,000 is refused before any workflow starts,
// and the refusal doesn't use up an opening number.
func TestBusinessRuleRefusal(t *testing.T) {
	m := newScriptedModel(
		transfer(prompts.InvestmentAgentName),
		transfer(prompts.OpenAccountAgentName),
		call("open_new_investment_account", map[string]any{"client_id": "123", "account_name": "Big", "initial_amount": 2_000_000}),
		text("Sorry, deposits over $1,000,000.00 must be arranged with a wealth advisor."),
		call("open_new_investment_account", map[string]any{"client_id": "123", "account_name": "Small", "initial_amount": 50}),
		text("Sorry, the initial deposit must be at least $100.00."),
		call("open_new_investment_account", map[string]any{"client_id": "123", "account_name": "Vacation", "initial_amount": 500}),
		text("Started."),
	)
	ce := newChatEnv(t, m)
	history := ce.run(t, "Open Big with $2,000,000", "Open Small with $50", "Open Vacation with $500")
	assert.Contains(t, history[0].JSONResponse, "The account cannot be opened: Initial deposits over $1,000,000.00")
	assert.Contains(t, history[1].JSONResponse, "The account cannot be opened: The initial deposit must be at least $100.00")
	assert.Contains(t, history[2].JSONResponse, vacation1)
}
