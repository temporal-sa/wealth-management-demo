/**
 * The standalone version: the agents as a command-line chat, with the Strands Agents TypeScript SDK and no
 * Temporal. The same "agents as tools" design as the Temporal version: the supervisor delegates to a
 * beneficiary agent and an investment agent, called as tools, and the tools call the data files directly.
 * Accounts are opened directly by one tool, so there is no KYC, compliance review or saga, and nothing
 * survives a crash or an outage.
 *
 * Run it from the framework folder with `npm run strands`.
 */
import * as readline from 'readline';
import { Agent, tool, type ToolList } from '@strands-agents/sdk';
import { z } from 'zod';
import {
  BENE_AGENT_NAME,
  BENE_INSTRUCTIONS,
  INVEST_AGENT_NAME,
  INVEST_INSTRUCTIONS,
  SUPERVISOR_AGENT_NAME,
  SUPERVISOR_INSTRUCTIONS,
} from '../prompts/agent-constants';
import { geminiModel } from '../durable/chaos-model';
import { loadWorkerConfig } from '../strands_lib/config';
import { DataStore } from '../strands_lib/data-store';
import { formatUsd } from '../strands_lib/money';

const MIN_INITIAL_DEPOSIT = 100;
const MAX_INITIAL_DEPOSIT = 1_000_000;

const store = new DataStore();
const clientId = z.string().describe("The customer's client ID");

const beneficiaryTools = [
  tool({
    name: 'list_beneficiaries',
    description: "List a client's beneficiaries.",
    inputSchema: z.object({ client_id: clientId }),
    callback: async ({ client_id }) => store.listBeneficiaries(client_id),
  }),
  tool({
    name: 'add_beneficiary',
    description: 'Add a new beneficiary for a client.',
    inputSchema: z.object({
      client_id: clientId,
      first_name: z.string(),
      last_name: z.string(),
      relationship: z.string(),
    }),
    callback: async (b) => {
      await store.addBeneficiary(b.client_id, b.first_name, b.last_name, b.relationship);
      return `Beneficiary ${b.first_name} ${b.last_name} added.`;
    },
  }),
  tool({
    name: 'delete_beneficiary',
    description: "Delete a client's beneficiary by its beneficiary ID.",
    inputSchema: z.object({ client_id: clientId, beneficiary_id: z.string() }),
    callback: async ({ client_id, beneficiary_id }) => {
      await store.deleteBeneficiary(client_id, beneficiary_id);
      return 'Beneficiary deleted.';
    },
  }),
];

const investmentTools = [
  tool({
    name: 'list_investments',
    description: "List a client's investment accounts and their balances.",
    inputSchema: z.object({ client_id: clientId }),
    callback: async ({ client_id }) => store.listInvestments(client_id),
  }),
  tool({
    name: 'open_investment',
    description: 'Open a new investment account with an initial deposit.',
    inputSchema: z.object({ client_id: clientId, name: z.string(), balance: z.number() }),
    callback: async ({ client_id, name, balance }) => {
      if (balance < MIN_INITIAL_DEPOSIT) {
        return `The account cannot be opened: the initial deposit must be at least ${formatUsd(MIN_INITIAL_DEPOSIT)}`;
      }
      if (balance > MAX_INITIAL_DEPOSIT) {
        return (
          `The account cannot be opened: initial deposits over ${formatUsd(MAX_INITIAL_DEPOSIT)} cannot be ` +
          'opened online and must be arranged with a wealth advisor'
        );
      }
      return store.addInvestment({ client_id, name, balance });
    },
  }),
  tool({
    name: 'close_investment',
    description: "Close a client's investment account by its investment ID.",
    inputSchema: z.object({ client_id: clientId, investment_id: z.string() }),
    callback: async ({ client_id, investment_id }) => {
      await store.deleteInvestment(client_id, investment_id);
      return 'Investment account closed.';
    },
  }),
];

async function main(): Promise<void> {
  const config = loadWorkerConfig();
  // Without Temporal, the SDK's own retries are all there is
  const model = geminiModel(config.model);
  const newAgent = (name: string, systemPrompt: string, tools: ToolList) =>
    new Agent({ name, model, systemPrompt, tools, printer: false });
  const trace: string[] = [];
  const assistantInput = z.object({ client_id: clientId, request: z.string() });
  const beneficiaryAgent = newAgent(BENE_AGENT_NAME, BENE_INSTRUCTIONS, beneficiaryTools);
  const investmentAgent = newAgent(INVEST_AGENT_NAME, INVEST_INSTRUCTIONS, investmentTools);
  const supervisor = newAgent(SUPERVISOR_AGENT_NAME, SUPERVISOR_INSTRUCTIONS, [
    tool({
      name: 'beneficiary_assistant',
      description: 'Handle a beneficiary request (list, add, or delete beneficiaries).',
      inputSchema: assistantInput,
      callback: async ({ client_id, request }) => {
        trace.push(`Handed off from ${SUPERVISOR_AGENT_NAME} to ${BENE_AGENT_NAME}`);
        return String(await beneficiaryAgent.invoke(`The client ID is ${client_id}. ${request}`));
      },
    }),
    tool({
      name: 'investment_assistant',
      description: 'Handle an investment-account request (list, open, or close investment accounts).',
      inputSchema: assistantInput,
      callback: async ({ client_id, request }) => {
        trace.push(`Handed off from ${SUPERVISOR_AGENT_NAME} to ${INVEST_AGENT_NAME}`);
        return String(await investmentAgent.invoke(`The client ID is ${client_id}. ${request}`));
      },
    }),
  ]);

  console.log(`Using model ${config.model}. Type exit, end or quit to leave.`);
  console.log('Welcome to ABC Wealth Management. How can I help you?');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'Enter your message: ' });
  // Piped input can close before its last lines are handled
  let closed = false;
  rl.on('close', () => (closed = true));
  rl.prompt();
  // Reading the lines with the iterator, rather than rl.question(), keeps lines that arrive mid-turn
  for await (const line of rl) {
    const input = line.trim();
    if (['exit', 'end', 'quit'].includes(input.toLowerCase())) break;
    if (input) {
      trace.length = 0;
      try {
        const reply = String(await supervisor.invoke(input)).trim();
        for (const t of trace) console.log(`  [${t}]`);
        console.log(`${SUPERVISOR_AGENT_NAME}: ${reply}`);
      } catch (err) {
        // Without Temporal, a failed model call loses the turn: the customer has to try again
        console.log(`Error: ${(err as Error).message}`);
      }
    }
    if (!closed) rl.prompt();
  }
  rl.close();
}

main()
  // The data store's Redis client, when DEMO_DATA_STORE=redis, would keep the process alive
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
