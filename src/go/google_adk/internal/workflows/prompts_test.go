package workflows

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/temporal-sa/adk-go-wealth-management/internal/prompts"
)

// TestOffTopicPrompt: the Temporal Supervisor Agent's prompt, as the model receives it,
// tells it to decline off-topic questions.
func TestOffTopicPrompt(t *testing.T) {
	m := newScriptedModel(text("I can only help with beneficiaries and investment accounts. How can I help with those?"))
	ce := newChatEnv(t, m)
	ce.run(t, "What's the weather in Paris?")
	instructions := m.systemInstructions()
	require.Len(t, instructions, 1)
	assert.Contains(t, instructions[0], prompts.OffTopicLine)
}

// TestPRDPromptLines: the lines the PRD requires word for word are in the prompts.
func TestPRDPromptLines(t *testing.T) {
	assert.Contains(t, prompts.SupervisorInstructions,
		"You only help with wealth management: the customer's beneficiaries and investment accounts. "+
			"If the customer asks about anything else (for example general knowledge, weather, news, or other financial products), "+
			"politely decline, say that you can only help with beneficiaries and investment accounts, and do not answer the question.")
	assert.Contains(t, prompts.OpenAccountInstructions,
		"Never state the status of an account opening from memory or from the conversation history: it changes without you being told. "+
			"Whenever you need it, call get_account_opening_status with the workflow ID returned by open_new_investment_account.")
	assert.Contains(t, prompts.OpenAccountInstructions,
		"Every request to open an account starts a new account opening: call open_new_investment_account each time, "+
			"even if an account with the same name was opened, or is still being opened, earlier in this conversation. "+
			"Don't ask the customer whether they want another one. Never answer a request to open an account from the conversation history.")
	assert.Contains(t, prompts.OpenAccountInstructions,
		"Every account opening needs its own KYC confirmation, even if the customer confirmed their details for an earlier one in this conversation.")
}
