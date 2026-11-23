# Standalone version: Microsoft Agent Framework only

The agents with [Microsoft Agent Framework](https://github.com/microsoft/agent-framework) alone, as a command-line chat
in C#. There is no Temporal here: the model and tool calls are not durable, and a crash loses the conversation. The
[Temporal version](temporal.md) runs the same design durably.

The agents are "agents as tools", as in the Temporal version: the Supervisor Agent calls the Beneficiary Agent and the
Investment Agent as tools, each with its own session for the whole chat, and their tools read and change the data files
directly ([`Standalone/Program.cs`](../Standalone/Program.cs)). The prompts are shared with the Temporal version
([`Common/Prompts.cs`](../Common/Prompts.cs)).

Scenarios:

- List, add and delete beneficiaries
- List, open and close investment accounts
- Off-topic questions are declined by the Supervisor Agent

## Run

Install the .NET 10 SDK and set up your OpenAI key as described in the [framework's README](../README.md). Then, from
the repository root:

```bash
./src/dotnet/agent_framework/scripts/startchat.sh
```

Type `end`, `exit` or `quit` to leave. The chat changes the shared files in the repository's `data/`; reset them with
`git checkout data/`.

Example:

```
Using model gpt-4o. Type exit, end or quit to leave.
Welcome to ABC Wealth Management. How can I help you?
Enter your message: Who are my beneficiaries? My client ID is 123.
  [Handed off from Supervisor Agent to Beneficiary Agent]
Supervisor Agent: Here are the current beneficiaries for client ID 123:

1. **John Doe** - Son
2. **Jane Doe** - Daughter
3. **Joan Doe** - Spouse

You can now choose to add a beneficiary, delete a beneficiary, or list beneficiaries again. Let me know how you'd like to proceed!
Enter your message: What is the capital of France?
Supervisor Agent: I'm sorry, but I can only help with your beneficiaries and investment accounts. Is there anything specific you would like to know or do regarding those?
Enter your message: end
```

## What it leaves out

Without Temporal, nothing is durable:

* **Opening an account** is one tool call (`open_investment`) that adds the account. There is no Open Account Agent,
  KYC, compliance review or saga. The deposit must still be from $100 to $1,000,000.
* **Deleting or closing** happens when the agent calls the tool: there are no approvals.
* **A failed model call loses the message**, once the OpenAI client's own retries run out. The chat prints the error and
  the customer has to send it again.
* **A crash loses the conversation**, which lives only in memory.
