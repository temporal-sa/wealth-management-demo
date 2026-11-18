/**
 * Off-topic and prompt lines: the Supervisor Agent's prompt, in the Temporal and standalone
 * versions, declines off-topic questions, and the lines the PRD requires word for word are in place.
 */
import assert from 'assert';
import { describe, it } from 'mocha';
import { BaseAgent, LlmAgent, ReadonlyContext } from '@google/adk';
import {
  BENE_AGENT_NAME,
  INVEST_AGENT_NAME,
  INVEST_INSTRUCTIONS,
  KYC_LINE,
  NEW_OPENING_LINE,
  OFF_TOPIC_LINE,
  OPEN_ACCOUNT_AGENT_NAME,
  OPEN_ACCOUNT_INSTRUCTIONS,
  STATUS_LINE,
  SUPERVISOR_AGENT_NAME,
  withClientId,
} from '../../common/agent-constants';
import { buildAgentTree } from '../../common/agents';
import { buildStandaloneAgents } from '../../adk_supervisor/main';

const PRD_OFF_TOPIC =
  "You only help with wealth management: the customer's beneficiaries and investment accounts. If the customer " +
  'asks about anything else (for example general knowledge, weather, news, or other financial products), politely ' +
  'decline, say that you can only help with beneficiaries and investment accounts, and do not answer the question.';
const PRD_STATUS =
  'Never state the status of an account opening from memory or from the conversation history: it changes without ' +
  'you being told. Whenever you need it, call get_account_opening_status with the workflow ID returned by ' +
  'open_new_investment_account.';
const PRD_NEW_OPENING =
  'Every request to open an account starts a new account opening: call open_new_investment_account each time, even ' +
  "if an account with the same name was opened, or is still being opened, earlier in this conversation. Don't ask " +
  'the customer whether they want another one. Never answer a request to open an account from the conversation history.';
const PRD_KYC =
  'Every account opening needs its own KYC confirmation, even if the customer confirmed their details for an earlier ' +
  'one in this conversation.';

/** An agent's instructions, as the model gets them. */
async function instructionsOf(agent: BaseAgent): Promise<string> {
  const llm = agent as LlmAgent;
  const { instruction } = await llm.canonicalInstruction({} as ReadonlyContext);
  return instruction;
}

function temporalTree(clientId?: string) {
  return buildAgentTree({
    model: () => 'scripted-model',
    clientId: () => clientId,
    rememberClientId: () => undefined,
    beneficiaryTools: [],
    investmentTools: [],
    openAccountTools: [],
    investmentInstructions: INVEST_INSTRUCTIONS,
  });
}

describe('prompts', () => {
  it('has the PRD lines word for word', () => {
    assert.strictEqual(OFF_TOPIC_LINE, PRD_OFF_TOPIC);
    assert.strictEqual(STATUS_LINE, PRD_STATUS);
    assert.strictEqual(NEW_OPENING_LINE, PRD_NEW_OPENING);
    assert.strictEqual(KYC_LINE, PRD_KYC);
    for (const line of [PRD_STATUS, PRD_NEW_OPENING, PRD_KYC]) assert.ok(OPEN_ACCOUNT_INSTRUCTIONS.includes(line));
  });

  it('declines off-topic questions in the Supervisor Agent prompt, Temporal and standalone', async () => {
    for (const root of [temporalTree(), buildStandaloneAgents('scripted-model')]) {
      assert.strictEqual(root.name, SUPERVISOR_AGENT_NAME);
      assert.ok((await instructionsOf(root)).includes(PRD_OFF_TOPIC));
    }
  });

  it('builds the four agents with the reference handoffs', () => {
    const root = temporalTree();
    assert.deepStrictEqual(
      root.subAgents.map((a) => a.name),
      [BENE_AGENT_NAME, INVEST_AGENT_NAME],
    );
    const invest = root.findAgent(INVEST_AGENT_NAME) as LlmAgent;
    assert.deepStrictEqual(
      invest.subAgents.map((a) => a.name),
      [OPEN_ACCOUNT_AGENT_NAME],
    );
    // A specialist goes back up, not sideways
    assert.ok(invest.disallowTransferToPeers);
    assert.ok((root.findAgent(BENE_AGENT_NAME) as LlmAgent).disallowTransferToPeers);
    // The standalone version has no Open Account Agent
    assert.strictEqual(buildStandaloneAgents('scripted-model').findAgent(OPEN_ACCOUNT_AGENT_NAME), undefined);
  });

  it('adds the client ID to every agent once it is known', async () => {
    const root = temporalTree('123');
    for (const name of [SUPERVISOR_AGENT_NAME, BENE_AGENT_NAME, INVEST_AGENT_NAME, OPEN_ACCOUNT_AGENT_NAME]) {
      assert.ok((await instructionsOf(root.findAgent(name)!)).includes("The customer's client ID is 123."), name);
    }
    assert.strictEqual(withClientId('x', undefined), 'x');
  });
});
