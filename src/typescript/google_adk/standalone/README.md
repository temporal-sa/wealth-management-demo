# Standalone version: Google ADK only

The agents with the [Google Agent Development Kit for TypeScript](https://github.com/google/adk-js)
alone, as a command-line chat. There is no Temporal here: the model and tool calls are not durable,
and a crash loses the conversation. The [Temporal version](../durable/README.md) runs the
same agents durably.

What it leaves out: there is no Open Account Agent, as in the reference framework's standalone version. The
Investment Agent opens an account directly with its `open_investment` tool, with no KYC, compliance
review or saga. The deposit must still be from $100 to $1,000,000.

Scenarios:

* List, add and delete beneficiaries
* List, open and close investment accounts
* Off-topic questions are declined by the Supervisor Agent

The agents, their prompts and the tree are shared with the Temporal version
([`adk_agents/agents.ts`](../adk_agents/agents.ts), [`prompts/agent-constants.ts`](../prompts/agent-constants.ts)).

## Run

Install the dependencies and set up your Gemini key as described in the [framework's README](../README.md).
Then, from `src/typescript/google_adk`:

```bash
source ../../../scripts/setgeminikey.sh && npm run adk
```

Type `end`, `exit` or `quit` to leave. The chat changes the shared files in the repository's `data/`; reset them with
`git checkout data/`.

Example:

```
Welcome to ABC Wealth Management. How can I help you?
Enter your message: Who are my beneficiaries?
Handed off from Supervisor_Agent to Beneficiary_Agent

Beneficiary_Agent: I can help with that. What is your client ID?

Enter your message: 123

Beneficiary_Agent: Here are your beneficiaries:

1. **John Doe** - Son
2. **Jane Doe** - Daughter
3. **Joan Doe** - Spouse

Would you like to add, delete or list your beneficiaries?
```
