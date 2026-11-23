# Standalone version: Strands Agents only

The agents with the [Strands Agents TypeScript SDK](https://github.com/strands-agents/sdk-typescript) alone, as a
command-line chat. There is no Temporal here: the model and tool calls are not durable, and a crash loses the
conversation. The [Temporal version](../durable/README.md) runs the same design durably.

The agents are "agents as tools", as in the Temporal version: the Supervisor Agent calls the Beneficiary Agent and
the Investment Agent as tools, and their tools read and change the data files directly
([`main.ts`](main.ts)). The prompts are shared with the Temporal version
([`prompts/agent-constants.ts`](../prompts/agent-constants.ts)).

Scenarios:

* List, add and delete beneficiaries
* List, open and close investment accounts
* Off-topic questions are declined by the Supervisor Agent

## Run

Install the dependencies and set up your Gemini key as described in the [framework's README](../README.md).
Then, from `src/typescript/strands_agents`:

```bash
source ../../../scripts/setgeminikey.sh && npm run strands
```

Type `end`, `exit` or `quit` to leave. The chat changes the shared files in the repository's `data/`; reset them with
`git checkout data/`.

Example:

```
Using model gemini-3.8-flash. Type exit, end or quit to leave.
Welcome to ABC Wealth Management. How can I help you?
Enter your message: Who are my beneficiaries? My client ID is 123.
  [Handed off from Supervisor Agent to Beneficiary Agent]
Supervisor Agent: Here are your beneficiaries:

1. **John Doe** - Son
2. **Jane Doe** - Daughter
3. **Joan Doe** - Spouse

You can add a beneficiary, delete a beneficiary, or list beneficiaries.
Enter your message: end
```

## What it leaves out

Without Temporal, nothing is durable:

* **Opening an account** is one tool call (`open_investment`) that adds the account. There is no Open Account
  Agent, KYC, compliance review or saga. The deposit must still be from $100 to $1,000,000.
* **Deleting or closing** happens when the agent calls the tool: there is no confirmation guard.
* **A failed model call loses the message.** The chat prints the error and the customer has to send it again.
* **A crash loses the conversation**, which lives only in memory.
