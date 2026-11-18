# Standalone version

The four agents as a command-line chat, in plain Python with no Temporal and no agent framework.
It uses the same agent loop ([common/agent_loop.py](../common/agent_loop.py)), agents and prompts
as the Temporal version. The model is called through LiteLLM, and the tools read and write the
JSON files in [data/](../../data) directly.

## Running it

Set up your model key first (see [Model key setup](../../README.md#model-key-setup)), then start the
chat from the repository root:

```bash
./src/pure_supervisor/startchat.sh
```

Type `exit`, `end` or `quit` to leave. Try:

* "Who are my beneficiaries?", then "123"
* "What investments do I have?"
* "Open an account called Vacation with $5,000"

Each reply shows the handoffs and tool calls in brackets, then the answering agent's message.

## What it leaves out

The standalone version is the "before" picture for the Temporal demo:

* **No KYC, compliance review or saga.** The Open Account Agent has one tool,
  `open_new_investment_account`, which checks the deposit rules ($100 to $1,000,000) and adds the
  account straight away. Its prompt is a shorter routine
  (`STANDALONE_OPEN_ACCOUNT_INSTRUCTIONS` in [common/agent_constants.py](../common/agent_constants.py)).
* **No durability.** The conversation lives in the process's memory. If the process stops, it's
  gone. If the model call fails, LiteLLM retries it 3 times. After that, the turn is dropped and an
  error is printed.
* **No web UI or chaos panel.**
