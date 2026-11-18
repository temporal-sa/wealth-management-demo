/**
 * The demo's ADK agent tree, shared by the Temporal and standalone versions. Each version supplies
 * its own models and tools.
 *
 *   Supervisor_Agent
 *   ├── Beneficiary_Agent          (transfers back to the supervisor only)
 *   └── Investment_Agent           (transfers back to the supervisor, or down to Open_Account_Agent)
 *       └── Open_Account_Agent     (Temporal version only; transfers back to Investment_Agent)
 *
 * ADK hands off between agents with its built-in transfer_to_agent tool, inside one turn, and the
 * next turn starts with the agent that answered last.
 *
 * Only @google/adk is imported, so the Temporal chat workflow can build the tree in workflow code.
 */
import { BaseAgent, BaseLlm, BaseTool, LlmAgent, type SingleBeforeToolCallback } from '@google/adk';
import {
  BENE_AGENT_NAME,
  BENE_HANDOFF,
  BENE_INSTRUCTIONS,
  INVEST_AGENT_NAME,
  INVEST_HANDOFF,
  OPEN_ACCOUNT_AGENT_NAME,
  OPEN_ACCOUNT_HANDOFF,
  OPEN_ACCOUNT_INSTRUCTIONS,
  SUPERVISOR_AGENT_NAME,
  SUPERVISOR_HANDOFF,
  SUPERVISOR_INSTRUCTIONS,
  withClientId,
} from './agent-constants';

export interface AgentTreeOptions {
  /** The model an agent uses, by agent name. */
  model: (agentName: string) => BaseLlm | string;
  /** The customer's client ID once a tool has used it. Every agent's instructions include it from then on. */
  clientId: () => string | undefined;
  /** Called with each tool call's client_id argument, before the tool runs. */
  rememberClientId: (clientId: string) => void;
  beneficiaryTools: BaseTool[];
  investmentTools: BaseTool[];
  /** When set, adds the Open Account Agent under the Investment Agent. */
  openAccountTools?: BaseTool[];
  /** The Investment Agent's instructions (they differ in the standalone version, which opens accounts itself). */
  investmentInstructions: string;
}

/** Builds the agent tree and returns its root, the Supervisor Agent. */
export function buildAgentTree(o: AgentTreeOptions): BaseAgent {
  const rememberClientId: SingleBeforeToolCallback = ({ args }) => {
    const id = args.client_id;
    if ((typeof id === 'string' && id !== '') || typeof id === 'number') {
      o.rememberClientId(String(id));
    }
    return undefined;
  };

  const agent = (
    name: string,
    description: string,
    instructions: string,
    tools: BaseTool[],
    subAgents: BaseAgent[],
    // Match the reference's handoffs: a specialist goes back up, not sideways to another specialist.
    disallowTransferToPeers: boolean,
  ) =>
    new LlmAgent({
      name,
      description,
      model: o.model(name),
      // A function, so the client ID is added once it is known (and ADK leaves the text as it is)
      instruction: () => withClientId(instructions, o.clientId()),
      tools,
      subAgents,
      disallowTransferToPeers,
      beforeToolCallback: rememberClientId,
    });

  const investmentSubAgents = o.openAccountTools
    ? [agent(OPEN_ACCOUNT_AGENT_NAME, OPEN_ACCOUNT_HANDOFF, OPEN_ACCOUNT_INSTRUCTIONS, o.openAccountTools, [], false)]
    : [];
  const investment = agent(
    INVEST_AGENT_NAME,
    INVEST_HANDOFF,
    o.investmentInstructions,
    o.investmentTools,
    investmentSubAgents,
    true,
  );
  const beneficiary = agent(BENE_AGENT_NAME, BENE_HANDOFF, BENE_INSTRUCTIONS, o.beneficiaryTools, [], true);
  return agent(
    SUPERVISOR_AGENT_NAME,
    SUPERVISOR_HANDOFF,
    SUPERVISOR_INSTRUCTIONS,
    [],
    [beneficiary, investment],
    false,
  );
}
