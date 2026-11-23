# Standalone version: OpenAI Agents SDK only

The agents with the [OpenAI Agents SDK for TypeScript](https://openai.github.io/openai-agents-js/) alone, as a
command-line chat. There is no Temporal here: the model and tool calls are not durable, and a crash loses the
conversation. The [Temporal version](../durable/README.md) runs the same design durably.

The agents use handoffs, as in the Temporal version and the
[Python framework's standalone version](../../../python/openai_agents/standalone/README.md): the Supervisor Agent hands
the conversation to the Beneficiary Agent or the Investment Agent, which answer the customer and hand it back for
anything else, and their tools read and change the data files directly ([`main.ts`](main.ts)). The prompts are
shared with the Temporal version ([`prompts/agent-constants.ts`](../prompts/agent-constants.ts)).

Scenarios:

- List, add and delete beneficiaries
- List, open and close investment accounts
- Off-topic questions are declined by the Supervisor Agent

## Run

Install the dependencies and set up your OpenAI key as described in the [framework's README](../README.md).
Then, from `src/typescript/openai_agents`:

```bash
source ../../../scripts/setoaikey.sh && npm run oai
```

Type `end`, `exit` or `quit` to leave. The chat changes the shared files in the repository's `data/`; reset them with
`git checkout data/`.

Example:

```
Using model gpt-4o. Type exit, end or quit to leave.
Welcome to ABC Wealth Management. How can I help you?
Enter your message: Who are my beneficiaries? My client ID is 123.
  [Handed off from Supervisor Agent to Beneficiary Agent]
Beneficiary Agent: Here are your beneficiaries:

1. **John Doe** - Son
2. **Jane Doe** - Daughter
3. **Joan Doe** - Spouse

Would you like to add, delete, or simply view your beneficiaries?
Enter your message: What investments do I have?
  [Handed off from Beneficiary Agent to Supervisor Agent]
  [Handed off from Supervisor Agent to Investment Agent]
Investment Agent: Here are your investment accounts and their balances:

1. **Checking**: $1,000.00
2. **Savings**: $2,312.08
3. **401K**: $11,070.89

Would you like to open, close, or view more details about any of these accounts?
Enter your message: end
```

## What it leaves out

Without Temporal, nothing is durable:

* **Opening an account** is one tool call (`open_investment`) that adds the account. There is no Open Account
  Agent, KYC, compliance review or saga. The deposit must still be from $100 to $1,000,000.
* **A failed model call loses the message**, once the OpenAI client's own retries run out. The chat prints the
  error and the customer has to send it again.
* **A crash loses the conversation**, which lives only in memory.
