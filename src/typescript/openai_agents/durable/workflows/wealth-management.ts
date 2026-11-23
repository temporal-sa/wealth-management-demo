/**
 * WealthManagementWorkflow: one chat. It runs the OpenAI Agents SDK agents inside the workflow, one customer
 * message at a time, with Temporal's OpenAI Agents integration (@temporalio/openai-agents): the
 * TemporalOpenAIRunner runs the agent loop in the workflow and every model call as an activity on the model
 * task queue, and every tool that touches the outside world runs an activity. The conversation lives in the
 * workflow, so a turn interrupted by a worker crash or an outage resumes where it stopped.
 *
 * The agents follow the Python OpenAI Agents framework's design: "handoffs". The supervisor hands the
 * conversation to a beneficiary agent or an investment agent, the investment agent hands account openings to
 * an open-account agent, which starts an OpenInvestmentAccountWorkflow child for every request to open an
 * account, and each hands back when the customer asks for something else. The agent that answered last
 * keeps the conversation for the customer's next message.
 */
import { Agent, tool, type AgentInputItem } from '@openai/agents-core';
import { TemporalOpenAIRunner } from '@temporalio/openai-agents/workflow';
import {
  ActivityFailure,
  ApplicationFailure,
  defineQuery,
  defineSignal,
  log,
  ParentClosePolicy,
  proxyActivities,
  proxyLocalActivities,
  setHandler,
  startChild,
  workflowInfo,
} from '@temporalio/workflow';
import { z } from 'zod';
import { CHAT_IDLE_TIMEOUT, waitForCustomer } from '../../../common/chat-idle';
import {
  BENE_AGENT_NAME,
  BENE_HANDOFF,
  BENE_INSTRUCTIONS,
  INVEST_AGENT_NAME,
  INVEST_HANDOFF,
  INVEST_INSTRUCTIONS,
  OPEN_ACCOUNT_AGENT_NAME,
  OPEN_ACCOUNT_HANDOFF,
  OPEN_ACCOUNT_INSTRUCTIONS,
  SUPERVISOR_AGENT_NAME,
  SUPERVISOR_HANDOFF,
  SUPERVISOR_INSTRUCTIONS,
} from '../../prompts/agent-constants';
import { CLIENT_FIELDS, type WealthManagementClient } from '../../oai_lib/client-record';
import type { WorkerConfig } from '../../oai_lib/config';
import type { Activities } from '../activities';
import { describeTurn } from '../turn';
import { LLM_RETRY_POLICY, MODEL_TIMEOUT, TOOL_RETRY_POLICY, TOOL_TIMEOUT } from '../retry-policies';
import {
  accountStatusText,
  ChatInteraction,
  END_WORKFLOW_SIGNAL,
  GET_ACCOUNT_OPENING_STATES_QUERY,
  GET_CHAT_HISTORY_QUERY,
  OPEN_INVESTMENT_ACCOUNT_WORKFLOW,
  OpenInvestmentAccountInput,
  PROCESS_USER_MESSAGE_SIGNAL,
  ProcessUserMessageInput,
  STATE_INITIALIZING,
  UPDATE_ACCOUNT_OPENING_STATE_SIGNAL,
  UpdateAccountOpeningStateInput,
} from '../shared';

export const ERROR_RESPONSE = 'Sorry, something went wrong while handling your request. Please try again.';
export const EMPTY_RESPONSE = "Sorry, I didn't catch that. Could you please say it again?";

export const KYC_NOT_APPROVED =
  'KYC was not approved. First show the customer their current details for this account opening ' +
  '(get_current_client_info) and ask whether they are correct. Approve KYC only after the customer ' +
  'confirms in their next message.';

/** Whether an account opening's details were shown in an earlier customer message (the KYC guard). */
export function kycConfirmed(shownTurn: number | undefined, turn: number): boolean {
  return shownTurn !== undefined && shownTurn < turn;
}

/** The open-account workflow ID: OpenAccount-<chat workflow ID>-<client ID>-<account name as given>-<n>. */
export function openAccountWorkflowId(
  chatWorkflowId: string,
  clientId: string,
  accountName: string,
  n: number,
): string {
  return `OpenAccount-${chatWorkflowId}-${clientId}-${accountName}-${n}`;
}

/** An agent's instructions, with the client ID once it is known, so an agent handed the chat doesn't ask again. */
export function withClientId(instructions: string, clientId: string | undefined): string {
  if (clientId === undefined) return instructions;
  return `${instructions}\n    The customer's client ID is ${clientId}. Use it, and don't ask for it again.`;
}

const toolActivities = proxyActivities<Activities>({ startToCloseTimeout: TOOL_TIMEOUT, retry: TOOL_RETRY_POLICY });
const { get_worker_config } = proxyLocalActivities<Activities>({ startToCloseTimeout: '10s' });

export const processUserMessageSignal = defineSignal<[ProcessUserMessageInput]>(PROCESS_USER_MESSAGE_SIGNAL);
export const endWorkflowSignal = defineSignal(END_WORKFLOW_SIGNAL);
export const updateAccountOpeningStateSignal = defineSignal<[UpdateAccountOpeningStateInput]>(
  UPDATE_ACCOUNT_OPENING_STATE_SIGNAL,
);
export const getChatHistoryQuery = defineQuery<ChatInteraction[]>(GET_CHAT_HISTORY_QUERY);
export const getAccountOpeningStatesQuery = defineQuery<Record<string, string>>(GET_ACCOUNT_OPENING_STATES_QUERY);

/** The business reason of a non-retryable activity failure, or undefined for any other error. */
function businessReason(err: unknown): string | undefined {
  if (err instanceof ActivityFailure && err.cause instanceof ApplicationFailure && err.cause.nonRetryable) {
    return err.cause.message;
  }
  return undefined;
}

export async function WealthManagementWorkflow(): Promise<void> {
  const { workflowId } = workflowInfo();

  const pendingMessages: string[] = [];
  const pendingStatuses: string[] = [];
  const chatHistory: ChatInteraction[] = [];
  let endWorkflow = false;

  // Everything the agents need to remember between turns is workflow state, so it is deterministic and
  // survives replay.
  let turn = 0;
  // The customer's client ID, once a tool has been called with it, shared by all the agents
  let clientId: string | undefined;
  // Latest state reported by each open-account child workflow, keyed by its workflow ID
  const accountOpeningStates: Record<string, string> = {};
  // Number of account openings started in this chat. The next one's workflow ID ends with this plus one.
  let accountOpeningsStarted = 0;
  // The customer turn in which each account opening's details were shown (the KYC guard)
  const kycDetailsShownTurn: Record<string, number> = {};

  setHandler(processUserMessageSignal, (input) => {
    log.info('Received user message', { message: input.user_input });
    pendingMessages.push(input.user_input);
  });
  setHandler(endWorkflowSignal, () => {
    endWorkflow = true;
  });
  // Recorded at once, even in the middle of a turn, so the next status check is up to date
  setHandler(updateAccountOpeningStateSignal, (update) => {
    if (update.workflow_id) accountOpeningStates[update.workflow_id] = update.state;
    pendingStatuses.push(accountStatusText(update.account_name, update.state));
  });
  setHandler(getChatHistoryQuery, () => chatHistory);
  setHandler(getAccountOpeningStatesQuery, () => accountOpeningStates);

  const config: WorkerConfig = await get_worker_config();

  // The UI reuses chat workflow IDs, so drop any earlier conversation stored under this one.
  await toolActivities.delete_conversation(workflowId);

  // Every model call is the integration's model activity, on the model task queue, retried until the model
  // answers. Set here because the chat is started by the API, with no client plugin to send them.
  const runner = new TemporalOpenAIRunner({
    defaultModelParams: {
      taskQueue: config.llm_task_queue,
      startToCloseTimeout: MODEL_TIMEOUT,
      retry: LLM_RETRY_POLICY,
    },
  });

  // -------------------------------------------------------------------------
  // Tools. They run in workflow code: anything that does I/O runs an activity.
  // -------------------------------------------------------------------------

  const clientIdParam = z.string().describe("The customer's client ID");
  const workflowIdParam = z.string().describe('The workflow ID returned by open_new_investment_account');

  /** Remembers the client ID a tool was called with, for every agent's instructions. */
  function seen(id: string): string {
    clientId = id;
    return id;
  }

  const listBeneficiaries = tool({
    name: 'list_beneficiaries',
    description: "List a client's beneficiaries.",
    parameters: z.object({ client_id: clientIdParam }),
    execute: async ({ client_id }) => toolActivities.list_beneficiaries(seen(client_id)),
  });
  const addBeneficiary = tool({
    name: 'add_beneficiary',
    description: 'Add a new beneficiary for a client.',
    parameters: z.object({
      client_id: clientIdParam,
      first_name: z.string(),
      last_name: z.string(),
      relationship: z.string().describe("The beneficiary's relationship to the customer, such as son or spouse"),
    }),
    execute: async (b) => {
      seen(b.client_id);
      await toolActivities.add_beneficiary(b);
      return `Beneficiary ${b.first_name} ${b.last_name} added.`;
    },
  });
  const deleteBeneficiary = tool({
    name: 'delete_beneficiary',
    description: "Delete a client's beneficiary by its beneficiary ID.",
    parameters: z.object({ client_id: clientIdParam, beneficiary_id: z.string() }),
    execute: async ({ client_id, beneficiary_id }) => {
      await toolActivities.delete_beneficiary(seen(client_id), beneficiary_id);
      return 'Beneficiary deleted.';
    },
  });

  const listInvestments = tool({
    name: 'list_investments',
    description: "List a client's investment accounts and their balances.",
    parameters: z.object({ client_id: clientIdParam }),
    execute: async ({ client_id }) => toolActivities.list_investments(seen(client_id)),
  });
  const closeInvestment = tool({
    name: 'close_investment',
    description: "Close a client's investment account by its investment ID.",
    parameters: z.object({ client_id: clientIdParam, investment_id: z.string() }),
    execute: async ({ client_id, investment_id }) => {
      await toolActivities.close_investment(seen(client_id), investment_id);
      return 'Investment account closed.';
    },
  });

  const openAccountTools = [
    tool({
      name: 'open_new_investment_account',
      description:
        'Begin opening a new investment account. Returns the workflow ID of the account opening, which the ' +
        'other open-account tools require, or the reason the account cannot be opened.',
      parameters: z.object({
        client_id: clientIdParam,
        account_name: z.string().describe('The name for the new investment account'),
        initial_amount: z.number().describe('The initial deposit amount'),
      }),
      execute: async (input) => openNewInvestmentAccount(input),
    }),
    tool({
      name: 'get_account_opening_status',
      description:
        'Get the current status of an account opening. "Complete" means the account was opened; a status ' +
        'starting with "Rolled back" means it was not opened. Either way, that account opening is finished.',
      parameters: z.object({ workflow_id: workflowIdParam }),
      execute: async ({ workflow_id }) =>
        accountOpeningStates[workflow_id] ??
        `No account opening with workflow ID ${workflow_id} was found in this conversation.`,
    }),
    tool({
      name: 'get_current_client_info',
      description: "Retrieve the customer's current details for an account opening, to show them for KYC.",
      parameters: z.object({ workflow_id: workflowIdParam }),
      execute: async ({ workflow_id }) => {
        const details = await toolActivities.get_current_client_info(workflow_id);
        kycDetailsShownTurn[workflow_id] = turn;
        return details;
      },
    }),
    tool({
      name: 'approve_kyc',
      description: 'Approve KYC for an account opening, after the customer confirmed their details are correct.',
      parameters: z.object({ workflow_id: workflowIdParam }),
      execute: async ({ workflow_id }) => {
        // The model sometimes treats a confirmation for an earlier opening as approval for a new one, or
        // approves in the same turn it shows the details: approve only once this opening's details were
        // shown and the customer has replied since.
        if (!kycConfirmed(kycDetailsShownTurn[workflow_id], turn)) return KYC_NOT_APPROVED;
        await toolActivities.approve_kyc(workflow_id);
        return 'KYC approved. The account is now waiting for compliance review.';
      },
    }),
    tool({
      name: 'update_client_details',
      description:
        "Update one or more of the customer's details during an account opening (this also completes KYC). " +
        'Set only the fields that change, and null for the others.',
      // OpenAI's strict schemas need every field, so the unchanged ones are null rather than left out
      parameters: z.object({
        workflow_id: workflowIdParam,
        ...Object.fromEntries(CLIENT_FIELDS.map((f) => [f, z.string().nullable()])),
      }),
      execute: async (input: Record<string, string | null>) => {
        const fields: Partial<WealthManagementClient> = {};
        for (const f of CLIENT_FIELDS) {
          const v = input[f];
          if (typeof v === 'string' && v !== '') fields[f] = v;
        }
        return toolActivities.update_client_details(input.workflow_id!, fields);
      },
    }),
  ];

  /** Validates the request, then starts an open-account child workflow with the next opening number. */
  async function openNewInvestmentAccount(input: {
    client_id: string;
    account_name: string;
    initial_amount: number;
  }): Promise<string> {
    const { client_id, account_name, initial_amount } = input;
    seen(client_id);
    // Business rules first. A broken rule fails on the first attempt and the reason goes back to the agent.
    try {
      await toolActivities.validate_new_account(client_id, account_name, initial_amount);
    } catch (err) {
      const reason = businessReason(err);
      if (reason) return `The account cannot be opened: ${reason}`;
      throw err;
    }
    // Read in an activity, so it is recorded in history and replays the same
    const promo_code = await toolActivities.find_promotion(client_id);
    const n = accountOpeningsStarted + 1;
    const childId = openAccountWorkflowId(workflowId, client_id, account_name, n);
    const childInput: OpenInvestmentAccountInput = { client_id, account_name, initial_amount, promo_code };
    await startChild(OPEN_INVESTMENT_ACCOUNT_WORKFLOW, {
      workflowId: childId,
      taskQueue: config.open_account_task_queue,
      parentClosePolicy: ParentClosePolicy.TERMINATE,
      args: [childInput],
    });
    accountOpeningsStarted = n;
    // Known from the start, so a status check right away doesn't report "not found"
    accountOpeningStates[childId] ??= STATE_INITIALIZING;
    // A bare ID reads like success, and models have told customers their account was open: say it isn't.
    return (
      'Account opening started. The account is NOT open yet: the customer must confirm their details (KYC), ' +
      `then it needs a compliance review. Workflow ID: ${childId}`
    );
  }

  // -------------------------------------------------------------------------
  // Agents: each hands the conversation to another ("handoffs"), as in the Python framework
  // -------------------------------------------------------------------------

  function agent(name: string, handoffDescription: string, instructions: string, tools: Agent['tools']): Agent {
    return new Agent({
      name,
      handoffDescription,
      instructions: () => withClientId(instructions, clientId),
      model: config.model,
      tools,
    });
  }

  const beneficiaryAgent = agent(BENE_AGENT_NAME, BENE_HANDOFF, BENE_INSTRUCTIONS, [
    listBeneficiaries,
    addBeneficiary,
    deleteBeneficiary,
  ]);
  const openAccountAgent = agent(
    OPEN_ACCOUNT_AGENT_NAME,
    OPEN_ACCOUNT_HANDOFF,
    OPEN_ACCOUNT_INSTRUCTIONS,
    openAccountTools,
  );
  const investmentAgent = agent(INVEST_AGENT_NAME, INVEST_HANDOFF, INVEST_INSTRUCTIONS, [
    listInvestments,
    closeInvestment,
  ]);
  const supervisorAgent = agent(SUPERVISOR_AGENT_NAME, SUPERVISOR_HANDOFF, SUPERVISOR_INSTRUCTIONS, []);
  supervisorAgent.handoffs.push(beneficiaryAgent, investmentAgent);
  beneficiaryAgent.handoffs.push(supervisorAgent);
  investmentAgent.handoffs.push(openAccountAgent, supervisorAgent);
  openAccountAgent.handoffs.push(investmentAgent);

  // The conversation so far, and the agent that answered last, which takes the next message
  let history: AgentInputItem[] = [];
  let currentAgent: Agent = supervisorAgent;

  async function processChatMessage(message: string): Promise<void> {
    turn += 1;
    let interaction: ChatInteraction;
    try {
      const result = await runner.run(currentAgent, [...history, { role: 'user', content: message }]);
      history = result.history;
      currentAgent = (result.lastAgent as Agent | undefined) ?? currentAgent;
      const { text, json, trace } = describeTurn(result.newItems);
      interaction = {
        user_prompt: message,
        text_response: text.trim() || EMPTY_RESPONSE,
        json_response: json,
        agent_trace: trace,
      };
    } catch (err) {
      // A turn that can't finish (a model call failing for good, say) must not end the chat. The message is
      // left out of the history, as if it was never sent.
      log.error('Agent turn failed', { error: (err as Error).message });
      interaction = {
        user_prompt: message,
        text_response: ERROR_RESPONSE,
        json_response: '',
        agent_trace: `error: ${(err as Error).message}\n`,
      };
    }
    chatHistory.push(interaction);
    await toolActivities.append_chat_interaction(workflowId, interaction);
  }

  for (;;) {
    if (!(await waitForCustomer(() => pendingMessages.length > 0 || pendingStatuses.length > 0 || endWorkflow))) {
      // Nobody has used this chat for a while (e.g. the tab was closed without End Chat)
      log.info(`Ending chat: idle for ${CHAT_IDLE_TIMEOUT}`);
      return;
    }
    if (endWorkflow) {
      log.info('Ending chat');
      return;
    }
    if (pendingMessages.length > 0) {
      await processChatMessage(pendingMessages.shift()!);
    }
    if (pendingStatuses.length > 0) {
      await toolActivities.append_status_update(workflowId, { status: pendingStatuses.shift()! });
    }

    // TODO: Continue-As-New. This demo keeps the whole conversation in one run. A production system would
    // continue-as-new when workflowInfo().continueAsNewSuggested is true: wait for allHandlersFinished(),
    // drain the queues, and carry the history, the current agent's name, the client ID, the account-opening
    // states, the opening count and the KYC guard into the new run, minding that the open-account children
    // use ParentClosePolicy.TERMINATE, which also applies on continue-as-new.
  }
}
