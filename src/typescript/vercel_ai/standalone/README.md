# Vercel AI SDK: standalone version (CLI)

Demonstrates how to use the [Vercel AI SDK](https://ai-sdk.dev/) using tools to hand off to other agents.

The Temporal version of this example is located [here](../durable/README.md).

Scenarios currently implemented include
* Add Beneficiary - add a new beneficiary to your account
* List Beneficiaries - shows a list of beneficiaries and their relationship to the account owner
* Delete Beneficiary - delete a beneficiary from your account
* Open Investment Account - opens a new investment account directly with a simple tool (the Temporal
  version adds KYC, compliance approval and a saga)
* List Investments - shows a list of accounts and their current balances
* Close Investment Account - closes an investment account
* Off-topic questions - questions that are not about beneficiaries or investment accounts are politely
  declined by the supervisor agent (this is handled in the agents' prompts)

## Prerequisites

- [Node.js 20+](https://nodejs.org/) and npm
- A [Google Gemini API key](https://aistudio.google.com/app/apikey) (the model is `GEMINI_MODEL`, default `gemini-3.8-flash`)

## Install dependencies

The TypeScript code is one set of npm workspaces. From `src/typescript`:

```bash
npm install
```

## Set up your Gemini API key

From the repository root, copy the shared Gemini key file and fill in your key:

```bash
cp scripts/setgeminikey.example scripts/setgeminikey.sh
```

It sets `GEMINI_API_KEY` (the Vercel AI SDK's own `GOOGLE_GENERATIVE_AI_API_KEY` also works) and is gitignored.
The CLI has no start script, so source it yourself as shown below.

## Run

From `src/typescript/vercel_ai`:

```bash
source ../../../scripts/setgeminikey.sh && npm run vai
```

Type `end`, `exit` or `quit` to leave.

Example Output
```
Welcome to ABC Wealth Management. How can I help you?
Enter your message: Who are my beneficiaries?

Supervisor Agent: I can help with that. What is your client ID?

Enter your message: 123
Handed off from Supervisor Agent to Beneficiary Agent

Beneficiary Agent: Here are your beneficiaries:
* John Doe (son)
* Jane Doe (daughter)
* Joan Doe (spouse)

Would you like to add, delete, or list your beneficiaries?

Enter your message: What investment accounts do I have?
Handed off from Beneficiary Agent to Supervisor Agent
Handed off from Supervisor Agent to Investment Agent

Investment Agent: Here are your investment accounts:

1. Checking: $1,000.00
2. Savings: $2,312.08
3. 401K: $11,070.89

Would you like to open an account, close an account, or list your accounts?

Enter your message: end
```

You can also add and delete beneficiaries and open and close investment accounts.

These changes are saved to the JSON files in [data/](../../../../data) (shared by every framework and tracked by
git). To reset the demo data, from the repository root:

```bash
git checkout data/
```
