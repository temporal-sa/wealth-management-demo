/**
 * The standalone version: the agents with Google ADK alone, as a command-line chat. There is no
 * Temporal here, so model and tool calls are not durable. Like the reference's standalone version it
 * has no Open Account Agent: the Investment Agent opens an account directly with its open_investment
 * tool, with no KYC, compliance review or saga.
 *
 * Usage (from src/typescript/google_adk): source ../../../scripts/setgeminikey.sh && npm run adk
 */
import * as readline from 'readline/promises';
import { BaseTool, FunctionTool, InMemoryRunner } from '@google/adk';
import { Type, type Schema } from '@google/genai';
import { STANDALONE_INVEST_INSTRUCTIONS } from '../prompts/agent-constants';
import { buildAgentTree } from '../adk_agents/agents';
import { claimCheckStatus, loadWorkerConfig } from '../adk_agents/config';
import { DataStore } from '../adk_agents/data-store';
import { formatUsd } from '../adk_agents/money';
import { MAX_INITIAL_DEPOSIT, MIN_INITIAL_DEPOSIT } from '../durable/shared';

const APP_NAME = 'wealth-management-standalone';
const USER_ID = 'customer';
const SESSION_ID = 'cli';

const store = new DataStore();
let clientId: string | undefined;

const str = (): Schema => ({ type: Type.STRING });
function tool<T>(
  name: string,
  description: string,
  properties: Record<string, Schema>,
  execute: (input: T) => unknown,
) {
  return new FunctionTool({
    name,
    description,
    parameters: { type: Type.OBJECT, properties, required: Object.keys(properties) },
    execute: (input) => execute(input as T),
  });
}

const beneficiaryTools: BaseTool[] = [
  tool<{ client_id: string }>(
    'list_beneficiaries',
    "List a client's beneficiaries.",
    { client_id: str() },
    ({ client_id }) => store.listBeneficiaries(client_id),
  ),
  tool<{ client_id: string; first_name: string; last_name: string; relationship: string }>(
    'add_beneficiary',
    'Add a new beneficiary for a client.',
    { client_id: str(), first_name: str(), last_name: str(), relationship: str() },
    async (b) => {
      await store.addBeneficiary(b.client_id, b.first_name, b.last_name, b.relationship);
      return 'Beneficiary added.';
    },
  ),
  tool<{ client_id: string; beneficiary_id: string }>(
    'delete_beneficiary',
    "Delete a client's beneficiary by its beneficiary ID.",
    { client_id: str(), beneficiary_id: str() },
    async ({ client_id, beneficiary_id }) => {
      await store.deleteBeneficiary(client_id, beneficiary_id);
      return 'Beneficiary deleted.';
    },
  ),
];

const investmentTools: BaseTool[] = [
  tool<{ client_id: string }>(
    'list_investments',
    "List a client's investment accounts and their balances.",
    { client_id: str() },
    ({ client_id }) => store.listInvestments(client_id),
  ),
  tool<{ client_id: string; investment_id: string }>(
    'close_investment',
    "Close a client's investment account by its investment ID.",
    { client_id: str(), investment_id: str() },
    async ({ client_id, investment_id }) => {
      await store.deleteInvestment(client_id, investment_id);
      return 'Investment account closed.';
    },
  ),
  tool<{ client_id: string; account_name: string; initial_amount: number }>(
    'open_investment',
    'Open a new investment account with an initial deposit.',
    { client_id: str(), account_name: str(), initial_amount: { type: Type.NUMBER } },
    ({ client_id, account_name, initial_amount }) => {
      if (!(initial_amount >= MIN_INITIAL_DEPOSIT) || initial_amount > MAX_INITIAL_DEPOSIT) {
        return `The account cannot be opened: the initial deposit must be from ${formatUsd(MIN_INITIAL_DEPOSIT)} to ${formatUsd(MAX_INITIAL_DEPOSIT)}.`;
      }
      return store.addInvestment({ client_id, name: account_name, balance: initial_amount });
    },
  ),
];

/** The standalone agent tree: no Open Account Agent, and the Investment Agent opens accounts itself. */
export function buildStandaloneAgents(model: string) {
  return buildAgentTree({
    model: () => model,
    clientId: () => clientId,
    rememberClientId: (id) => {
      clientId = id;
    },
    beneficiaryTools,
    investmentTools,
    investmentInstructions: STANDALONE_INVEST_INSTRUCTIONS,
  });
}

async function main(): Promise<void> {
  console.log(claimCheckStatus());
  const { model } = loadWorkerConfig();
  const runner = new InMemoryRunner({ agent: buildStandaloneAgents(model), appName: APP_NAME });
  await runner.sessionService.createSession({ appName: APP_NAME, userId: USER_ID, sessionId: SESSION_ID });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('Welcome to ABC Wealth Management. How can I help you?');
  for (;;) {
    const input = (await rl.question('Enter your message: ')).trim();
    if (['end', 'exit', 'quit'].includes(input.toLowerCase())) break;
    if (!input) continue;
    try {
      for await (const event of runner.runAsync({
        userId: USER_ID,
        sessionId: SESSION_ID,
        newMessage: { role: 'user', parts: [{ text: input }] },
      })) {
        const parts = event.content?.parts ?? [];
        const target = event.actions?.transferToAgent;
        if (target) console.log(`Handed off from ${event.author} to ${target}`);
        if (parts.some((p) => p.functionCall)) continue;
        const text = parts.map((p) => (p.thought ? '' : (p.text ?? ''))).join('');
        if (text && !event.partial) console.log(`\n${event.author}: ${text}\n`);
      }
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
    }
  }
  rl.close();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
