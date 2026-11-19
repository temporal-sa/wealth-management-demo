/**
 * OpenInvestmentAccountWorkflow: one account opening, started by the chat workflow as a child (or on
 * its own by the open-account runner). It loads the client's details, waits for KYC and a compliance
 * officer's approval, then runs a saga that creates, funds and registers the account, undoing the
 * completed steps in reverse order if one fails for a business reason. Every state change is
 * signalled to the parent chat workflow.
 *
 * It is interchangeable with the Java workflow in java/: same handlers, states, transfer IDs and
 * activity calls.
 */
import {
  ActivityFailure,
  ApplicationFailure,
  condition,
  defineQuery,
  defineSignal,
  defineUpdate,
  getExternalWorkflowHandle,
  log,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import type { WealthManagementClient } from '../../adk_agents/data-store';
import { formatUsd } from '../../adk_agents/money';
import type { Activities } from '../activities';
import { TOOL_RETRY_POLICY, TOOL_TIMEOUT } from '../retry-policies';
import {
  COMPLIANCE_APPROVED_SIGNAL,
  GET_CLIENT_DETAILS_UPDATE,
  GET_CURRENT_STATE_QUERY,
  OpenInvestmentAccountInput,
  OpenInvestmentAccountOutput,
  STATE_COMPLETE,
  STATE_COMPLIANCE_APPROVED,
  STATE_CREATING_RECORD,
  STATE_INITIALIZING,
  STATE_REGISTERING,
  STATE_WAITING_COMPLIANCE,
  STATE_WAITING_KYC,
  UPDATE_ACCOUNT_OPENING_STATE_SIGNAL,
  UPDATE_CLIENT_DETAILS_UPDATE,
  UpdateAccountOpeningStateInput,
  VERIFY_KYC_SIGNAL,
} from '../shared';

// The activities run on the chat worker's task queue, so a Java open-account workflow on another
// queue calls the same ones. One attempt may take 30 seconds; an outage is retried for as long as it lasts.
const {
  get_client,
  update_client,
  open_investment,
  remove_investment,
  debit_linked_account,
  credit_linked_account,
  register_account,
} = proxyActivities<Activities>({ startToCloseTimeout: TOOL_TIMEOUT, retry: TOOL_RETRY_POLICY });

export const verifyKycSignal = defineSignal(VERIFY_KYC_SIGNAL);
export const complianceApprovedSignal = defineSignal(COMPLIANCE_APPROVED_SIGNAL);
export const getCurrentStateQuery = defineQuery<string>(GET_CURRENT_STATE_QUERY);
// An update rather than a query, so a caller that asks right after the start waits until the
// details have been loaded instead of getting nothing
export const getClientDetailsUpdate = defineUpdate<WealthManagementClient | null>(GET_CLIENT_DETAILS_UPDATE);
export const updateClientDetailsUpdate = defineUpdate<string, [Partial<WealthManagementClient>]>(
  UPDATE_CLIENT_DETAILS_UPDATE,
);

// Welcome-bonus promotion: a share of the initial deposit, up to a maximum
interface Promotion {
  rate: number;
}
const MAX_BONUS = 500;

// *** Bug-In-Workflow-Code ***
// A deliberate bug for the "Bug in workflow code" chaos flag: the promo code is WELCOME-BONUS (a
// hyphen), but the promotion is keyed WELCOME_BONUS (an underscore), so welcomeBonus gets undefined
// and reading its rate throws a TypeError. That fails the workflow task, not the workflow: the
// workflow stays Running with the compliance approval kept, and Temporal retries the task. To fix it,
// uncomment the first line below, delete the second, and restart the worker: the opening resumes and
// completes with the bonus.
// const PROMOTIONS: Record<string, Promotion> = { 'WELCOME-BONUS': { rate: 0.01 } };
const PROMOTIONS: Record<string, Promotion> = { WELCOME_BONUS: { rate: 0.01 } };

function welcomeBonus(promoCode: string, initialAmount: number): number {
  const promotion = PROMOTIONS[promoCode];
  return Math.min(initialAmount * promotion.rate, MAX_BONUS);
}

export async function OpenInvestmentAccountWorkflow(
  input: OpenInvestmentAccountInput,
): Promise<OpenInvestmentAccountOutput> {
  const { client_id, account_name, initial_amount, promo_code } = input;
  let state = STATE_INITIALIZING;
  let initialized = false;
  let kycVerified = false;
  let complianceReviewed = false;
  let client: WealthManagementClient | null = null;

  // Every state change is visible to get_current_state and signalled to the parent chat workflow,
  // which keeps it for the agent's get_account_opening_status tool and shows it in the UI. A
  // workflow started on its own has no parent to tell.
  async function setState(newState: string): Promise<void> {
    state = newState;
    log.info(`State: ${newState}`, { account_name });
    const parent = workflowInfo().parent;
    if (!parent) return;
    const update: UpdateAccountOpeningStateInput = {
      account_name,
      state: newState,
      workflow_id: workflowInfo().workflowId,
    };
    await getExternalWorkflowHandle(parent.workflowId).signal(UPDATE_ACCOUNT_OPENING_STATE_SIGNAL, update);
  }

  setHandler(getCurrentStateQuery, () => state);
  // Each handler waits for the steps before it, so an early signal takes effect once the workflow
  // gets there: KYC once the details are loaded, compliance once KYC is verified.
  setHandler(verifyKycSignal, async () => {
    await condition(() => initialized);
    kycVerified = true;
  });
  setHandler(complianceApprovedSignal, async () => {
    await condition(() => initialized && kycVerified);
    complianceReviewed = true;
  });
  setHandler(getClientDetailsUpdate, async () => {
    await condition(() => initialized);
    return client;
  });
  // The customer changed their details during KYC: save them, which also completes KYC
  setHandler(updateClientDetailsUpdate, async (fields) => {
    const result = await update_client(client_id, fields);
    client = client ? { ...client, ...fields } : client;
    kycVerified = true;
    return result;
  });

  log.info('OpenInvestmentAccountWorkflow started', { client_id, account_name, initial_amount, promo_code });
  client = await get_client(client_id);
  initialized = true;
  await setState(STATE_WAITING_KYC);

  await condition(() => kycVerified);
  await setState(STATE_WAITING_COMPLIANCE);

  await condition(() => complianceReviewed);
  await setState(STATE_COMPLIANCE_APPROVED);
  return openAccount();

  // The saga: each completed step registers how to undo it. If a later step fails with a
  // non-retryable error, the compensations run in reverse order. Transient failures never get here:
  // the activities retry until they succeed.
  async function openAccount(): Promise<OpenInvestmentAccountOutput> {
    const bonus = promo_code ? welcomeBonus(promo_code, initial_amount) : 0;
    // Idempotency key: stable across activity retries and worker restarts. The run ID keeps a
    // workflow ID started again by hand from looking like a repeat of an earlier transfer.
    const { workflowId, runId } = workflowInfo();
    const transferId = `${workflowId}-${runId}-initial-deposit`;
    const compensations: Array<{ description: string; undo: () => Promise<unknown> }> = [];
    try {
      await setState(STATE_CREATING_RECORD);
      const account = await open_investment({ client_id, name: account_name, balance: initial_amount + bonus });
      compensations.unshift({
        description: 'removing the account record',
        undo: () => remove_investment(client_id, account.investment_id),
      });

      await setState(`Transferring ${formatUsd(initial_amount)} from the linked bank account.`);
      await debit_linked_account(client_id, initial_amount, transferId);
      compensations.unshift({
        description: `refunding ${formatUsd(initial_amount)} to the linked bank account`,
        undo: () => credit_linked_account(client_id, initial_amount, `${transferId}-refund`),
      });

      await setState(STATE_REGISTERING);
      await register_account(client_id, account.investment_id, initial_amount);
    } catch (err) {
      if (!(err instanceof ActivityFailure)) throw err;
      const reason = failureReason(err);
      await setState(`Failed: ${reason}. Rolling back.`);
      for (const { description, undo } of compensations) {
        await setState(`Rolling back: ${description}.`);
        // Compensations are activities too, so they are retried until they succeed
        await undo();
      }
      await setState(`Rolled back. The account was not opened: ${reason}.`);
      return { account_created: false, message: `The account was not opened: ${reason}` };
    }

    await setState(STATE_COMPLETE);
    return { account_created: true, message: 'investment account created' };
  }
}

/** The business reason for a non-retryable activity failure, such as the custodian rejecting the account. */
function failureReason(err: ActivityFailure): string {
  return err.cause instanceof ApplicationFailure ? err.cause.message : (err.cause?.message ?? err.message);
}
