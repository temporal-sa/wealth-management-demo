# Standalone version: Google ADK alone

The same agents, run with Google ADK for Go and no Temporal, as a command-line chat. It shows what
the demo looks like before Temporal: nothing is durable, so a crash or an outage loses the turn.

The agents are a Supervisor Agent, a Beneficiary Agent and an Investment Agent, with the same prompts
and tools as the Temporal version. The Supervisor hands the conversation to a specialist with ADK's
`transfer_to_agent`, in the same turn.

What it leaves out: there is **no Open Account Agent, KYC, compliance review or saga**. The
Investment Agent opens an account directly with its `open_investment` tool, which adds the account
record and nothing else. There is also no chaos panel or web UI.

## Run it

Set up your Gemini API key first (see the [root README](../README.md#set-up-your-gemini-api-key)).
From the repository root:

```bash
./scripts/startcli.sh
```

Then chat, for example:

```text
Enter your message: Who are my beneficiaries?
Enter your message: 123
Enter your message: What investments do I have?
Enter your message: Open an account called Vacation with $500
```

Type `end`, or press Ctrl-D, to leave. The chat reads and changes the files in `data/`; reset them
with `git checkout data/`.
