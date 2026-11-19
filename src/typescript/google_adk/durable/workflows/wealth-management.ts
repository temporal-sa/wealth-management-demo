/**
 * WealthManagementWorkflow: one chat. It runs the ADK agent tree inside the workflow, one customer
 * message at a time, with Temporal's Google ADK integration: every model call is an activity on the
 * model task queue, and every tool that touches the outside world runs an activity. The agent loop,
 * the handoffs and the conversation state live in the workflow, so a turn interrupted by a worker
 * crash or an outage resumes where it stopped.
 *
 * It also starts an OpenInvestmentAccountWorkflow child for every request to open an account, and
 * records each opening's state from the child's update_account_opening_state signals.
 */
import { BasePlugin, BaseTool, createEvent, FunctionTool, InMemoryRunner, type LlmResponse } from '@google/adk';
import { Type, type Schema } from '@google/genai';
import { markModelFailureHandled, TemporalModel } from '@temporalio/google-adk/workflow';
import {
  ActivityFailure,
  ApplicationFailure,
  condition,
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
import { CHAT_IDLE_TIMEOUT, waitForCustomer } from '../../../common/chat-idle';
import { INVEST_INSTRUCTIONS } from '../../prompts/agent-constants';
import { buildAgentTree } from '../../adk_agents/agents';
import type { WorkerConfig } from '../../adk_agents/config';
import { CLIENT_FIELDS, type WealthManagementClient } from '../../adk_agents/data-store';
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
  STATE_COMPLETE,
  STATE_INITIALIZING,
  UPDATE_ACCOUNT_OPENING_STATE_SIGNAL,
  UpdateAccountOpeningStateInput,
} from '../shared';

const APP_NAME = 'wealth-management';
const USER_ID = 'customer';

/** Sent when the model ends a turn with no text and no tool call, which Gemini occasionally does. */
export const EMPTY_RESPONSE_NUDGE = 'Please continue, following your instructions.';
export const EMPTY_RESPONSE_FALLBACK = "Sorry, I didn't catch that. Could you please say it again?";
export const ERROR_RESPONSE = 'Sorry, something went wrong while handling your request. Please try again.';

export const KYC_NOT_APPROVED =
  'KYC was not approved. First show the customer all of their current details for this account opening ' +
  '(get_current_client_info) and ask whether they are correct. Approve KYC only after the customer ' +
  'confirms in their next message.';

/** All of these must appear in a reply for the customer's details to count as shown. */
const KYC_DISPLAYED_FIELDS: Array<keyof WealthManagementClient> = ['first_name', 'last_name', 'email'];

const toolActivities = proxyActivities<Activities>({ startToCloseTimeout: TOOL_TIMEOUT, retry: TOOL_RETRY_POLICY });
const { get_worker_config } = proxyLocalActivities<Activities>({ startToCloseTimeout: '10s' });

export const processUserMessageSignal = defineSignal<[ProcessUserMessageInput]>(PROCESS_USER_MESSAGE_SIGNAL);
export const endWorkflowSignal = defineSignal(END_WORKFLOW_SIGNAL);
export const updateAccountOpeningStateSignal = defineSignal<[UpdateAccountOpeningStateInput]>(
  UPDATE_ACCOUNT_OPENING_STATE_SIGNAL,
);
export const getChatHistoryQuery = defineQuery<ChatInteraction[]>(GET_CHAT_HISTORY_QUERY);
export const getAccountOpeningStatesQuery = defineQuery<Record<string, string>>(GET_ACCOUNT_OPENING_STATES_QUERY);

/** The open-account workflow ID: OpenAccount-<chat workflow ID>-<client ID>-<account name as given>-<n>. */
export function openAccountWorkflowId(
  chatWorkflowId: string,
  clientId: string,
  accountName: string,
  n: number,
): string {
  return `OpenAccount-${chatWorkflowId}-${clientId}-${accountName}-${n}`;
}

/** Why approve_kyc must not approve KYC for this opening yet, or undefined if it may. */
export function kycApprovalRefusal(shownTurn: number | undefined, turn: number): string | undefined {
  return shownTurn === undefined || shownTurn >= turn ? KYC_NOT_APPROVED : undefined;
}

/** Whether the reply the customer sees contains the details fetched for KYC. */
export function detailsDisplayed(details: WealthManagementClient | null, reply: string): boolean {
  if (!details) return false;
  const text = reply.toLowerCase();
  return KYC_DISPLAYED_FIELDS.every((field) => {
    const value = String(details[field] ?? '').toLowerCase();
    return value === '' || text.includes(value);
  });
}

/**
 * Turns a model failure ADK would otherwise end the turn with into a reply, so the chat carries on.
 * Outages never get here: the model activity retries them until the model answers. Only a
 * non-retryable failure (a request the model refuses, say) does.
 */
class ModelErrorPlugin extends BasePlugin {
  constructor() {
    super('model_error_reply');
  }
  override async onModelErrorCallback(params: { error: Error }): Promise<LlmResponse | undefined> {
    log.warn('Model call failed; replying with an error message', { error: params.error.message });
    markModelFailureHandled(params.error);
    return createEvent({ content: { role: 'model', parts: [{ text: ERROR_RESPONSE }] } }) as unknown as LlmResponse;
  }
}

function objectSchema(properties: Record<string, Schema>, required: string[]): Schema {
  return { type: Type.OBJECT, properties, required };
}
const str = (description?: string): Schema => ({ type: Type.STRING, description });

/** A tool whose input is checked by the model's function declaration. */
function tool<T>(name: string, description: string, parameters: Schema, execute: (input: T) => Promise<unknown>) {
  return new FunctionTool({ name, description, parameters, execute: (input) => execute(input as T) });
}

export async function WealthManagementWorkflow(): Promise<void> {
  const { workflowId } = workflowInfo();

  const pendingMessages: string[] = [];
  const pendingStatuses: string[] = [];
  const chatHistory: ChatInteraction[] = [];
  let endWorkflow = false;

  // Everything the agents need to remember between turns is workflow state, so it is deterministic
  // and survives replay.
  let clientId: string | undefined;
  // Latest state reported by each open-account child workflow, keyed by its workflow ID
  const accountOpeningStates: Record<string, string> = {};
  // Number of account openings started in this chat. The next one's workflow ID ends with this plus one.
  let accountOpeningsStarted = 0;
  // KYC guard (see approve_kyc): the number of the customer message being handled, the details
  // fetched for each opening in this turn, and the turn in which they were shown to the customer
  let turn = 0;
  let kycDetailsFetched: Record<string, WealthManagementClient | null> = {};
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

  // -------------------------------------------------------------------------
  // Tools. They run in workflow code: anything that does I/O runs an activity.
  // -------------------------------------------------------------------------

  const beneficiaryTools: BaseTool[] = [
    tool<{ client_id: string }>(
      'list_beneficiaries',
      "List a client's beneficiaries.",
      objectSchema({ client_id: str() }, ['client_id']),
      ({ client_id }) => toolActivities.list_beneficiaries(client_id),
    ),
    tool<{ client_id: string; first_name: string; last_name: string; relationship: string }>(
      'add_beneficiary',
      'Add a new beneficiary for a client.',
      objectSchema({ client_id: str(), first_name: str(), last_name: str(), relationship: str() }, [
        'client_id',
        'first_name',
        'last_name',
        'relationship',
      ]),
      async (b) => {
        await toolActivities.add_beneficiary(b);
        return 'Beneficiary added.';
      },
    ),
    tool<{ client_id: string; beneficiary_id: string }>(
      'delete_beneficiary',
      "Delete a client's beneficiary by its beneficiary ID.",
      objectSchema({ client_id: str(), beneficiary_id: str() }, ['client_id', 'beneficiary_id']),
      async ({ client_id, beneficiary_id }) => {
        await toolActivities.delete_beneficiary(client_id, beneficiary_id);
        return 'Beneficiary deleted.';
      },
    ),
  ];

  const investmentTools: BaseTool[] = [
    tool<{ client_id: string }>(
      'list_investments',
      "List a client's investment accounts and their balances.",
      objectSchema({ client_id: str() }, ['client_id']),
      ({ client_id }) => toolActivities.list_investments(client_id),
    ),
    tool<{ client_id: string; investment_id: string }>(
      'close_investment',
      "Close a client's investment account by its investment ID.",
      objectSchema({ client_id: str(), investment_id: str() }, ['client_id', 'investment_id']),
      async ({ client_id, investment_id }) => {
        await toolActivities.close_investment(client_id, investment_id);
        return 'Investment account closed.';
      },
    ),
  ];

  const workflowIdParam = objectSchema(
    { workflow_id: str('The workflow ID returned by open_new_investment_account') },
    ['workflow_id'],
  );

  const openAccountTools: BaseTool[] = [
    tool<{ client_id: string; account_name: string; initial_amount: number }>(
      'open_new_investment_account',
      'Begin opening a new investment account. Every call starts a new account opening, with its own KYC. ' +
        'Returns the workflow ID of the account opening, which the other open-account tools require, ' +
        'or the reason the account cannot be opened.',
      objectSchema(
        {
          client_id: str(),
          account_name: str('The name of the new investment account'),
          initial_amount: { type: Type.NUMBER, description: 'The initial deposit, in dollars' },
        },
        ['client_id', 'account_name', 'initial_amount'],
      ),
      openNewInvestmentAccount,
    ),
    tool<{ workflow_id: string }>(
      'get_account_opening_status',
      'Get the current status of an account opening. "Complete" means the account was opened; a status ' +
        'starting with "Rolled back" means it was not opened. Either way, that account opening is finished.',
      workflowIdParam,
      async ({ workflow_id }) => accountOpeningStatus(workflow_id),
    ),
    tool<{ workflow_id: string }>(
      'get_current_client_info',
      "Retrieve the customer's current details for an account opening, to show them for KYC. " +
        'Show all of them to the customer and ask whether they are correct.',
      workflowIdParam,
      async ({ workflow_id }) => {
        const details = await toolActivities.get_current_client_info(workflow_id);
        kycDetailsFetched[workflow_id] = details;
        return details;
      },
    ),
    tool<{ workflow_id: string }>(
      'approve_kyc',
      'Approve KYC for an account opening, after the customer confirmed their details are correct. ' +
        'Returns whether KYC was approved and, if not, what to do first.',
      workflowIdParam,
      async ({ workflow_id }) => {
        // The model sometimes approves KYC without showing the details, or treats a confirmation for
        // an earlier opening as approval for a new one: approve only once this opening's details were
        // shown in a reply and the customer has answered since.
        const refusal = kycApprovalRefusal(kycDetailsShownTurn[workflow_id], turn);
        if (refusal) return refusal;
        await toolActivities.approve_kyc(workflow_id);
        return 'KYC approved. The account is now waiting for compliance review.';
      },
    ),
    tool<{ workflow_id: string } & Partial<WealthManagementClient>>(
      'update_client_details',
      "Update one or more of the customer's details during an account opening. Set only the fields that " +
        'change. This completes KYC.',
      objectSchema(
        {
          workflow_id: str('The workflow ID returned by open_new_investment_account'),
          ...Object.fromEntries(CLIENT_FIELDS.map((f) => [f, str()])),
        },
        ['workflow_id'],
      ),
      async ({ workflow_id, ...rest }) => {
        const fields: Partial<WealthManagementClient> = {};
        for (const f of CLIENT_FIELDS) {
          const v = rest[f];
          if (typeof v === 'string' && v !== '') fields[f] = v;
        }
        return toolActivities.update_client_details(workflow_id, fields);
      },
    ),
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
      if (err instanceof ActivityFailure && err.cause instanceof ApplicationFailure && err.cause.nonRetryable) {
        return `The account cannot be opened: ${err.cause.message}`;
      }
      throw err;
    }
    // Read in an activity, so it is recorded in history and replays the same
    const promo_code = await toolActivities.find_promotion(client_id);

    // ADK runs a turn's tool calls one at a time, so two openings requested in one model response
    // get different numbers. The count goes up only once the opening has started.
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
    return childId;
  }

  /** The state the open-account workflow last reported. No activity: it is kept from the child's signals. */
  function accountOpeningStatus(id: string): string {
    const state = accountOpeningStates[id];
    if (state === undefined) return `No account opening with workflow ID ${id} was found in this conversation.`;
    if (state === STATE_COMPLETE || state.startsWith('Rolled back')) {
      // The model has read a finished opening's status as the answer to a new request to open the
      // same account, so say what to do then.
      return (
        `${state}\nThis account opening is finished. If the customer is asking to open an account now, ` +
        'call open_new_investment_account to start a new account opening.'
      );
    }
    return state;
  }

  // -------------------------------------------------------------------------
  // Agents
  // -------------------------------------------------------------------------

  const root = buildAgentTree({
    // Each model call is the integration's model activity, on the model task queue, retried until
    // the model answers. Its summary in the Temporal UI is the agent's name.
    model: (agentName) =>
      new TemporalModel(config.model, {
        activity: {
          taskQueue: config.llm_task_queue,
          startToCloseTimeout: MODEL_TIMEOUT,
          retry: LLM_RETRY_POLICY,
        },
        summary: agentName,
      }),
    clientId: () => clientId,
    rememberClientId: (id) => {
      clientId = id;
    },
    beneficiaryTools,
    investmentTools,
    openAccountTools,
    investmentInstructions: INVEST_INSTRUCTIONS,
  });
  const runner = new InMemoryRunner({ agent: root, appName: APP_NAME, plugins: [new ModelErrorPlugin()] });
  await runner.sessionService.createSession({ appName: APP_NAME, userId: USER_ID, sessionId: workflowId });

  /** Runs the agents on one message: the reply text, the agent trace and the tool results. */
  async function runAgents(message: string): Promise<{ text: string; trace: string; json: string }> {
    let text = '';
    let trace = '';
    let json = '';
    try {
      for await (const event of runner.runAsync({
        userId: USER_ID,
        sessionId: workflowId,
        newMessage: { role: 'user', parts: [{ text: message }] },
      })) {
        const parts = event.content?.parts ?? [];
        const calls = parts.filter((p) => p.functionCall);
        for (const p of calls) {
          if (p.functionCall!.name !== 'transfer_to_agent')
            trace += `${event.author}: Calling a tool: ${p.functionCall!.name}\n`;
        }
        for (const p of parts) {
          if (p.functionResponse && p.functionResponse.name !== 'transfer_to_agent') {
            json += `${JSON.stringify(p.functionResponse.response)}\n`;
          }
        }
        if (calls.length === 0 && !event.partial) {
          for (const p of parts) if (p.text && !p.thought) text += p.text;
        }
        const target = event.actions?.transferToAgent;
        if (target) trace += `Handed off from ${event.author} to ${target}\n`;
      }
    } catch (err) {
      // A turn that can't finish must not end the chat: say so, and the customer can try again.
      log.error('Agent run failed', { error: (err as Error).message });
      trace += `error: ${(err as Error).message}\n`;
      if (text === '') text = ERROR_RESPONSE;
    }
    return { text, trace, json };
  }

  async function processChatMessage(message: string): Promise<void> {
    turn += 1;
    kycDetailsFetched = {};
    let { text, trace, json } = await runAgents(message);
    if (text.trim() === '') {
      // The model ended the turn without saying anything. Nudge it once, then fall back to a canned
      // reply rather than show the customer an empty message.
      log.warn('Model returned no text; nudging it once');
      const retry = await runAgents(EMPTY_RESPONSE_NUDGE);
      text = retry.text.trim() === '' ? EMPTY_RESPONSE_FALLBACK : retry.text;
      trace += retry.trace;
      json += retry.json;
    }
    // Details only count as shown if the reply the customer sees contains them
    for (const [openingId, details] of Object.entries(kycDetailsFetched)) {
      if (detailsDisplayed(details, text)) kycDetailsShownTurn[openingId] = turn;
    }
    const interaction: ChatInteraction = {
      user_prompt: message,
      text_response: text,
      json_response: json,
      agent_trace: trace,
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

    // TODO: Continue-As-New.
    // This demo keeps the whole conversation in one workflow run. A production system would call
    // continueAsNew when workflowInfo().continueAsNewSuggested is true, because Temporal limits a
    // run's event history (warnings at 10K events / 10 MB, terminated at 50K events / 50 MB) and every
    // model and tool call adds events, so a long chat would eventually hit those limits. To do it safely:
    //   - Wait for allHandlersFinished() and drain the pending message and status queues first, so no
    //     customer message or status update is lost.
    //   - Carry the conversation state into the new run: the ADK session's events, the client ID, the
    //     account-opening states and count, and the KYC guard's turn tracking.
    //   - Open-account children are started with ParentClosePolicy.TERMINATE, which also applies when
    //     the parent continues-as-new, so an opening waiting for KYC or compliance would be
    //     terminated. Use ABANDON and have end_workflow cancel any openings still running, or defer
    //     continue-as-new until none is in progress.
  }
}
