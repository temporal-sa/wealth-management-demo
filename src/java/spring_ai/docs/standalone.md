# Standalone version

The four agents as a command-line chat, with Spring AI and no Temporal. It runs the same agents and turn loop as the
Temporal version ([agents/Conversation.java](../src/main/java/io/temporal/demo/springai/agents/Conversation.java)),
with a plain Spring AI `ChatClient` calling Gemini and tools that call the data files directly. Prerequisites and
the Gemini key are in the [framework README](../README.md).

## Running it

From the repository root:

```bash
./src/java/spring_ai/scripts/startchat.sh
```

It sources `scripts/setgeminikey.sh` if it exists. Example:

```
Using model gemini-3.8-flash. Type exit, end or quit to leave.
Welcome to ABC Wealth Management. How can I help you?
Enter your message: What investments do I have? My client ID is 123.
  [Handed off from Supervisor Agent to Investment Agent]
  [Investment Agent: Calling a tool]
Investment Agent: Here are your investment accounts:

1. **Checking:** $1,000.00
2. **Savings:** $2,312.08
3. **401K:** $11,070.89

Would you like to open, close, or list your investment accounts?
Enter your message: end
```

The chat changes the shared JSON files in [data/](../../../../data); reset them with `git checkout data/`.

## What it leaves out

Without Temporal, nothing is durable:

* **Opening an account** is one tool call that adds the account. There is no KYC, compliance review or saga, and no
  account-opening workflow.
* **A failed model call loses the message**: the chat prints the error and the customer has to send it again.
* **A crash loses the conversation**, which lives only in memory.
