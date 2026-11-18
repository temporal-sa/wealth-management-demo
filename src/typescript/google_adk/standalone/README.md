# Standalone version: Google ADK only

The agents with the [Google Agent Development Kit for TypeScript](https://github.com/google/adk-js)
alone, as a command-line chat. There is no Temporal here: the model and tool calls are not durable,
and a crash loses the conversation. The [Temporal version](../temporal_supervisor/README.md) runs the
same agents durably.

What it leaves out: there is no Open Account Agent, as in the reference port's standalone version. The
Investment Agent opens an account directly with its `open_investment` tool, with no KYC, compliance
review or saga. The deposit must still be from $100 to $1,000,000.

Scenarios:

* List, add and delete beneficiaries
* List, open and close investment accounts
* Off-topic questions are declined by the Supervisor Agent

The agents, their prompts and the tree are shared with the Temporal version
([`src/common/agents.ts`](../common/agents.ts), [`src/common/agent-constants.ts`](../common/agent-constants.ts)).

## Run

Install the dependencies and set up your Gemini key as described in the [root README](../../README.md).
Then, from the repository root:

```bash
source setgeminikey.sh && npm run adk
```

Type `end`, `exit` or `quit` to leave. The chat changes the files in `data/`; reset them with
`git checkout data/`.

Example:

```
Welcome to ABC Wealth Management. How can I help you?
Enter your message: Who are my beneficiaries?
Handed off from Supervisor_Agent to Beneficiary_Agent

Beneficiary_Agent: I can help with that. What is your client ID?

Enter your message: 123

Beneficiary_Agent: Here are your beneficiaries:
* John Doe (son)
* Jane Doe (daughter)
* Joe Doe (spouse)
Would you like to add, delete or list your beneficiaries?
```
