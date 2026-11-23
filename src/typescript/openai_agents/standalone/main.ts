/**
 * The standalone version: the agents as a command-line chat, with the OpenAI Agents SDK and no Temporal. The
 * same "handoffs" design as the Temporal version and the Python framework's standalone version: the supervisor
 * hands the conversation to a beneficiary agent or an investment agent, which hand it back, and the tools call
 * the data files directly. Accounts are opened directly by one tool, so there is no KYC, compliance review or
 * saga, and nothing survives a crash or an outage.
 *
 * Run it from the framework folder with `npm run oai`.
 */
import * as readline from 'readline';
import { Agent, run, tool, type AgentInputItem, type Tool } from '@openai/agents';
import { z } from 'zod';
import {
  BENE_AGENT_NAME,
  BENE_HANDOFF,
  BENE_INSTRUCTIONS,
  INVEST_AGENT_NAME,
  INVEST_HANDOFF,
  INVEST_INSTRUCTIONS,
  SUPERVISOR_AGENT_NAME,
  SUPERVISOR_HANDOFF,
  SUPERVISOR_INSTRUCTIONS,
} from '../prompts/agent-constants';
import { describeTurn } from '../durable/turn';
import { loadWorkerConfig } from '../oai_lib/config';
import { DataStore } from '../oai_lib/data-store';
import { formatUsd } from '../oai_lib/money';

const MIN_INITIAL_DEPOSIT = 100;
const MAX_INITIAL_DEPOSIT = 1_000_000;

const store = new DataStore();
const clientId = z.string().describe("The customer's client ID");

const beneficiaryTools = [
  tool({
    name: 'list_beneficiaries',
    description: "List a client's beneficiaries.",
    parameters: z.object({ client_id: clientId }),
    execute: async ({ client_id }) => store.listBeneficiaries(client_id),
  }),
  tool({
    name: 'add_beneficiary',
    description: 'Add a new beneficiary for a client.',
    parameters: z.object({
      client_id: clientId,
      first_name: z.string(),
      last_name: z.string(),
      relationship: z.string(),
    }),
    execute: async (b) => {
      await store.addBeneficiary(b.client_id, b.first_name, b.last_name, b.relationship);
      return `Beneficiary ${b.first_name} ${b.last_name} added.`;
    },
  }),
  tool({
    name: 'delete_beneficiary',
    description: "Delete a client's beneficiary by its beneficiary ID.",
    parameters: z.object({ client_id: clientId, beneficiary_id: z.string() }),
    execute: async ({ client_id, beneficiary_id }) => {
      await store.deleteBeneficiary(client_id, beneficiary_id);
      return 'Beneficiary deleted.';
    },
  }),
];

const investmentTools = [
  tool({
    name: 'list_investments',
    description: "List a client's investment accounts and their balances.",
    parameters: z.object({ client_id: clientId }),
    execute: async ({ client_id }) => store.listInvestments(client_id),
  }),
  tool({
    name: 'open_investment',
    description: 'Open a new investment account with an initial deposit.',
    parameters: z.object({ client_id: clientId, name: z.string(), balance: z.number() }),
    execute: async ({ client_id, name, balance }) => {
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
    parameters: z.object({ client_id: clientId, investment_id: z.string() }),
    execute: async ({ client_id, investment_id }) => {
      await store.deleteInvestment(client_id, investment_id);
      return 'Investment account closed.';
    },
  }),
];

async function main(): Promise<void> {
  const config = loadWorkerConfig();
  const newAgent = (name: string, handoffDescription: string, instructions: string, tools: Tool[]) =>
    new Agent({ name, handoffDescription, instructions, model: config.model, tools });
  const beneficiaryAgent = newAgent(BENE_AGENT_NAME, BENE_HANDOFF, BENE_INSTRUCTIONS, beneficiaryTools);
  const investmentAgent = newAgent(INVEST_AGENT_NAME, INVEST_HANDOFF, INVEST_INSTRUCTIONS, investmentTools);
  const supervisor = newAgent(SUPERVISOR_AGENT_NAME, SUPERVISOR_HANDOFF, SUPERVISOR_INSTRUCTIONS, []);
  supervisor.handoffs.push(beneficiaryAgent, investmentAgent);
  beneficiaryAgent.handoffs.push(supervisor);
  investmentAgent.handoffs.push(supervisor);
  // The conversation, and the agent that answered last, which takes the next message
  let history: AgentInputItem[] = [];
  let current: Agent = supervisor;

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
      try {
        const result = await run(current, [...history, { role: 'user', content: input }]);
        history = result.history;
        current = (result.lastAgent as Agent | undefined) ?? current;
        const { text, trace } = describeTurn(result.newItems);
        for (const t of trace
          .trim()
          .split('\n')
          .filter((l) => l.startsWith('Handed off')))
          console.log(`  [${t}]`);
        console.log(`${current.name}: ${text.trim()}`);
      } catch (err) {
        // Without Temporal, a failed model call loses the turn (after the OpenAI client's own retries): the
        // customer has to try again
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
