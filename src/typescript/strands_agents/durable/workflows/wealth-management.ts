/**
 * WealthManagementWorkflow: one chat. It runs the Strands agents inside the workflow, one customer message at
 * a time, with Temporal's Strands Agents integration (@temporalio/strands-agents): every agent is a
 * TemporalAgent, so every model call is an activity on the model task queue, and every tool that touches the
 * outside world runs an activity. The agent loops and the conversation live in the workflow, so a turn
 * interrupted by a worker crash or an outage resumes where it stopped.
 *
 * The agents follow the Python Strands framework's "agents as tools" design: the supervisor delegates to a
 * beneficiary agent and an investment agent, each called as a tool, and the investment agent delegates
 * account openings to a dedicated open-account agent, which starts an OpenInvestmentAccountWorkflow child for
 * every request to open an account. The specialized agents are kept for the whole chat, so they remember what
 * they asked the customer.
 */
import { BeforeToolCallEvent, tool, type ToolList } from '@strands-agents/sdk';
import { TemporalAgent } from '@temporalio/strands-agents';
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
  BENE_INSTRUCTIONS,
  INVEST_AGENT_NAME,
  OPEN_ACCOUNT_AGENT_NAME,
  OPEN_ACCOUNT_INSTRUCTIONS,
  SUPERVISOR_AGENT_NAME,
  TEMPORAL_INVEST_SUBAGENT_INSTRUCTIONS,
  TEMPORAL_SUPERVISOR_INSTRUCTIONS,
} from '../../prompts/agent-constants';
import { CLIENT_FIELDS, type WealthManagementClient } from '../../strands_lib/client-record';
import type { WorkerConfig } from '../../strands_lib/config';
import { MODEL_NAME } from '../../strands_lib/model-name';
import type { Activities } from '../activities';
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

/** Tools that delete or close something, so the customer must confirm them in the chat first. */
const CONFIRMATION_QUESTIONS: Record<string, string> = {
  delete_beneficiary: 'Are you sure you want to delete beneficiary <first and last name>?',
  close_investment: 'Are you sure you want to close your <account name> account?',
};

export function notConfirmed(toolName: string): string {
  return (
    `Not done: the customer has not confirmed this yet. Ask the customer "${CONFIRMATION_QUESTIONS[toolName]}" ` +
    `and stop. Call ${toolName} again only after the customer says yes in their next message.`
  );
}

/** Whether the customer was asked to confirm this exact call in their previous message. */
export function confirmed(askedTurn: number | undefined, turn: number): boolean {
  return askedTurn !== undefined && askedTurn === turn - 1;
}

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
  // The customer turn in which each delete or close was refused so the agent could ask the customer to
  // confirm it, keyed by the tool and its input
  const confirmationsAsked: Record<string, number> = {};
  // Latest state and account name reported by each open-account child workflow, keyed by its workflow ID
  const accountOpeningStates: Record<string, string> = {};
  const accountOpeningNames: Record<string, string> = {};
  // Number of account openings started in this chat. The next one's workflow ID ends with this plus one.
  let accountOpeningsStarted = 0;
  // The customer turn in which each account opening's details were shown (the KYC guard)
  const kycDetailsShownTurn: Record<string, number> = {};
  // What this turn's agents did, for the chat history: handoffs and tool calls, and the tools' results
  let trace: string[] = [];
  let toolOutputs: string[] = [];

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

  /** A TemporalAgent: every model call is the integration's model activity, retried until the model answers. */
  function agent(name: string, systemPrompt: string, tools: ToolList): TemporalAgent {
    const a = new TemporalAgent({
      name,
      model: MODEL_NAME,
      systemPrompt,
      tools,
      printer: false,
      activityOptions: {
        taskQueue: config.llm_task_queue,
        startToCloseTimeout: MODEL_TIMEOUT,
        retry: LLM_RETRY_POLICY,
      },
    });
    // Each tool call goes in the chat history's trace. The hook runs in workflow code, and only records.
    a.addHook(BeforeToolCallEvent, (event) => {
      trace.push(`${name}: Calling a tool: ${event.toolUse.name}`);
    });
    return a;
  }

  /** A tool whose result also goes in the chat history (json_response). */
  function recorded<T>(value: T): T {
    toolOutputs.push(typeof value === 'string' ? value : JSON.stringify(value));
    return value;
  }

  /**
   * Refuses a delete or close until the customer has confirmed it in the chat: the first call returns a
   * request to ask, and the same call in the customer's next message runs.
   */
  function confirmationRefusal(toolName: string, input: Record<string, unknown>): string | undefined {
    const key = `${toolName}:${JSON.stringify(
      Object.keys(input)
        .sort()
        .map((k) => [k, String(input[k])]),
    )}`;
    if (confirmed(confirmationsAsked[key], turn)) {
      delete confirmationsAsked[key];
      return undefined;
    }
    confirmationsAsked[key] = turn;
    return notConfirmed(toolName);
  }

  // -------------------------------------------------------------------------
  // Tools. They run in workflow code: anything that does I/O runs an activity.
  // -------------------------------------------------------------------------

  const clientId = z.string().describe("The customer's client ID");
  const workflowIdParam = z.string().describe('The workflow ID returned by open_new_investment_account');

  const beneficiaryTools = [
    tool({
      name: 'list_beneficiaries',
      description: "List a client's beneficiaries.",
      inputSchema: z.object({ client_id: clientId }),
      callback: async ({ client_id }) => recorded(await toolActivities.list_beneficiaries(client_id)),
    }),
    tool({
      name: 'add_beneficiary',
      description: 'Add a new beneficiary for a client.',
      inputSchema: z.object({
        client_id: clientId,
        first_name: z.string(),
        last_name: z.string(),
        relationship: z.string().describe("The beneficiary's relationship to the customer, such as son or spouse"),
      }),
      callback: async (b) => {
        await toolActivities.add_beneficiary(b);
        return recorded(`Beneficiary ${b.first_name} ${b.last_name} added.`);
      },
    }),
    tool({
      name: 'delete_beneficiary',
      description: "Delete a client's beneficiary by its beneficiary ID.",
      inputSchema: z.object({ client_id: clientId, beneficiary_id: z.string() }),
      callback: async (input) => {
        const refusal = confirmationRefusal('delete_beneficiary', input);
        if (refusal) return refusal;
        await toolActivities.delete_beneficiary(input.client_id, input.beneficiary_id);
        return recorded('Beneficiary deleted.');
      },
    }),
  ];

  const openAccountTools = [
    tool({
      name: 'open_new_investment_account',
      description:
        'Begin opening a new investment account via a durable child workflow. Returns the workflow ID, which ' +
        'the other open-account tools require, or the reason the account cannot be opened. Starting the ' +
        'opening does not open the account: it still needs KYC and a compliance review.',
      inputSchema: z.object({
        client_id: clientId,
        account_name: z.string().describe('The name for the new investment account'),
        initial_amount: z.number().describe('The initial deposit amount'),
      }),
      callback: async (input) => recorded(await openNewInvestmentAccount(input)),
    }),
    tool({
      name: 'get_account_opening_status',
      description:
        'Get the current status of an account opening. "Complete" means the account was opened; a status ' +
        'starting with "Rolled back" means it was not opened. Either way, that account opening is finished.',
      inputSchema: z.object({ workflow_id: workflowIdParam }),
      callback: async ({ workflow_id }) =>
        recorded(
          accountOpeningStates[workflow_id] ??
            `No account opening with workflow ID ${workflow_id} was found in this conversation.`,
        ),
    }),
    tool({
      name: 'get_current_client_info',
      description: "Retrieve the customer's current details for an account opening, to show them for KYC.",
      inputSchema: z.object({ workflow_id: workflowIdParam }),
      callback: async ({ workflow_id }) => {
        const details = await toolActivities.get_current_client_info(workflow_id);
        kycDetailsShownTurn[workflow_id] = turn;
        return recorded(details);
      },
    }),
    tool({
      name: 'approve_kyc',
      description: 'Approve KYC for an account opening, after the customer confirmed their details are correct.',
      inputSchema: z.object({ workflow_id: workflowIdParam }),
      callback: async ({ workflow_id }) => {
        // The model sometimes treats a confirmation for an earlier opening as approval for a new one, or
        // approves in the same turn it shows the details: approve only once this opening's details were
        // shown and the customer has replied since.
        if (!kycConfirmed(kycDetailsShownTurn[workflow_id], turn)) return recorded(KYC_NOT_APPROVED);
        await toolActivities.approve_kyc(workflow_id);
        return recorded('KYC approved. The account is now waiting for compliance review.');
      },
    }),
    tool({
      name: 'update_client_details',
      description:
        "Update one or more of the customer's details during an account opening (this also completes KYC). " +
        'Set only the fields that change.',
      inputSchema: z.object({
        workflow_id: workflowIdParam,
        ...Object.fromEntries(CLIENT_FIELDS.map((f) => [f, z.string().optional()])),
      }),
      callback: async (input: Record<string, string | undefined>) => {
        const fields: Partial<WealthManagementClient> = {};
        for (const f of CLIENT_FIELDS) {
          const v = input[f];
          if (typeof v === 'string' && v !== '') fields[f] = v;
        }
        return recorded(await toolActivities.update_client_details(input.workflow_id!, fields));
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
    accountOpeningNames[childId] ??= account_name;
    // A bare ID reads like success, and models have told customers their account was open: say it isn't.
    return (
      'Account opening started. The account is NOT open yet: the customer must confirm their details (KYC), ' +
      `then it needs a compliance review. Workflow ID: ${childId}`
    );
  }

  /** The current status of each account opening, to put before a request to the open-account agent. */
  function accountOpeningsSummary(): string {
    const ids = Object.keys(accountOpeningStates);
    if (ids.length === 0) return '';
    const openings = ids
      .map((id) => `${accountOpeningNames[id] ?? id} (workflow ID ${id}): "${accountOpeningStates[id]}"`)
      .join('; ');
    return `Current status of account openings in this conversation: ${openings}. `;
  }

  // -------------------------------------------------------------------------
  // Agents: the specialized agents are called as tools ("agents as tools"), and kept for the whole chat
  // -------------------------------------------------------------------------

  const request = (client_id: string, text: string) => `The client ID is ${client_id}. ${text}`;
  const assistantInput = z.object({
    client_id: clientId,
    request: z.string().describe('What the customer wants done, in their words'),
  });

  const openAccountAgent = agent(OPEN_ACCOUNT_AGENT_NAME, OPEN_ACCOUNT_INSTRUCTIONS, openAccountTools);
  const openAccountAssistant = tool({
    name: 'open_account_assistant',
    description:
      'Open a new investment account (a multi-step, durable KYC + compliance flow). This delegates to a ' +
      'persistent open-account agent: relay whatever the customer said and relay its reply back.',
    inputSchema: assistantInput,
    callback: async ({ client_id, request: text }) => {
      trace.push(`Handed off from ${INVEST_AGENT_NAME} to ${OPEN_ACCOUNT_AGENT_NAME}`);
      // Its history holds whatever status it last saw, so give it the current status on every turn
      return String(await openAccountAgent.invoke(request(client_id, `${accountOpeningsSummary()}${text}`)));
    },
  });

  const beneficiaryAgent = agent(BENE_AGENT_NAME, BENE_INSTRUCTIONS, beneficiaryTools);
  const investmentAgent = agent(INVEST_AGENT_NAME, TEMPORAL_INVEST_SUBAGENT_INSTRUCTIONS, [
    tool({
      name: 'list_investments',
      description: "List a client's investment accounts and their balances.",
      inputSchema: z.object({ client_id: clientId }),
      callback: async ({ client_id }) => recorded(await toolActivities.list_investments(client_id)),
    }),
    tool({
      name: 'close_investment',
      description: "Close a client's investment account by its investment ID.",
      inputSchema: z.object({ client_id: clientId, investment_id: z.string() }),
      callback: async (input) => {
        const refusal = confirmationRefusal('close_investment', input);
        if (refusal) return refusal;
        await toolActivities.close_investment(input.client_id, input.investment_id);
        return recorded('Investment account closed.');
      },
    }),
    openAccountAssistant,
  ]);

  const supervisor = agent(SUPERVISOR_AGENT_NAME, TEMPORAL_SUPERVISOR_INSTRUCTIONS, [
    tool({
      name: 'beneficiary_assistant',
      description: 'Handle a beneficiary request (list, add, or delete beneficiaries).',
      inputSchema: assistantInput,
      callback: async ({ client_id, request: text }) => {
        trace.push(`Handed off from ${SUPERVISOR_AGENT_NAME} to ${BENE_AGENT_NAME}`);
        return String(await beneficiaryAgent.invoke(request(client_id, text)));
      },
    }),
    tool({
      name: 'investment_assistant',
      description:
        'Handle any investment-account request: list, close, or open an account (opening is delegated onward ' +
        'to the open-account agent).',
      inputSchema: assistantInput,
      callback: async ({ client_id, request: text }) => {
        trace.push(`Handed off from ${SUPERVISOR_AGENT_NAME} to ${INVEST_AGENT_NAME}`);
        return String(await investmentAgent.invoke(request(client_id, text)));
      },
    }),
  ]);

  async function processChatMessage(message: string): Promise<void> {
    turn += 1;
    trace = [];
    toolOutputs = [];
    let text: string;
    try {
      text = String(await supervisor.invoke(message)).trim() || EMPTY_RESPONSE;
    } catch (err) {
      // A turn that can't finish (a model call failing for good, say) must not end the chat
      log.error('Agent turn failed', { error: (err as Error).message });
      trace.push(`error: ${(err as Error).message}`);
      text = ERROR_RESPONSE;
    }
    const interaction: ChatInteraction = {
      user_prompt: message,
      text_response: text,
      json_response: toolOutputs.map((o) => `${o}\n`).join(''),
      agent_trace: trace.map((t) => `${t}\n`).join(''),
    };
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
    // drain the queues, and carry each agent's messages (TemporalAgent's `messages` option), the
    // account-opening states, the turn counters and the guards into the new run, minding that the
    // open-account children use ParentClosePolicy.TERMINATE, which also applies on continue-as-new.
  }
}
