/**
 * Every activity, registered under the snake_case names of the shared Temporal contract. The Java
 * open-account worker and the other frameworks' scripts call them by these names.
 *
 * createActivities builds them over a data store, an event stream and a Temporal client, so the
 * tests can run them over a copy of the demo data, an in-memory event stream and the test server.
 */
import { ApplicationFailure } from '@temporalio/common';
import { log } from '@temporalio/activity';
import type { Client } from '@temporalio/client';
import { ChaosFlag } from '../../common/chaos-manager';
import { WorkerConfig } from '../strands_lib/config';
import {
  Beneficiary,
  DataStore,
  InsufficientFundsError,
  InvestmentAccount,
  InvestmentRecord,
  Transfer,
  WealthManagementClient,
} from '../strands_lib/data-store';
import { formatUsd } from '../strands_lib/money';
import { coreBankingApi, injectFailure, isEnabled, maybeSlowDown } from './chaos';
import { EventStream } from './redis/event-stream-manager';
import {
  ChatInteraction,
  CUSTODIAN_REJECTED,
  DEPOSIT_BELOW_MINIMUM,
  DEPOSIT_LIMIT_EXCEEDED,
  GET_CLIENT_DETAILS_UPDATE,
  INSUFFICIENT_FUNDS,
  MAX_INITIAL_DEPOSIT,
  MIN_INITIAL_DEPOSIT,
  StatusUpdate,
  UPDATE_CLIENT_DETAILS_UPDATE,
  VERIFY_KYC_SIGNAL,
  WELCOME_BONUS_PROMO_CODE,
} from './shared';

export interface ActivityDeps {
  store: DataStore;
  events: EventStream;
  /** The Temporal client the chat-side open-account activities use to reach the child workflow. */
  client: () => Promise<Client>;
  config: WorkerConfig;
}

/** The deposit rules for a new account: from $100 to $1,000,000. */
export function checkDeposit(initialAmount: number): void {
  if (!(initialAmount >= MIN_INITIAL_DEPOSIT)) {
    throw ApplicationFailure.nonRetryable(
      `The initial deposit must be at least ${formatUsd(MIN_INITIAL_DEPOSIT)}`,
      DEPOSIT_BELOW_MINIMUM,
    );
  }
  if (initialAmount > MAX_INITIAL_DEPOSIT) {
    throw ApplicationFailure.nonRetryable(
      `Initial deposits over ${formatUsd(MAX_INITIAL_DEPOSIT)} cannot be opened online and must be arranged with a wealth advisor`,
      DEPOSIT_LIMIT_EXCEEDED,
    );
  }
}

export function createActivities(deps: ActivityDeps) {
  const { store, events } = deps;

  return {
    // -----------------------------------------------------------------------
    // Beneficiaries
    // -----------------------------------------------------------------------

    async list_beneficiaries(client_id: string): Promise<Beneficiary[]> {
      log.info('list_beneficiaries', { client_id });
      await coreBankingApi();
      return store.listBeneficiaries(client_id);
    },

    async add_beneficiary(b: {
      client_id: string;
      first_name: string;
      last_name: string;
      relationship: string;
    }): Promise<Beneficiary> {
      log.info('add_beneficiary', { client_id: b.client_id, first_name: b.first_name, last_name: b.last_name });
      await coreBankingApi();
      return store.addBeneficiary(b.client_id, b.first_name, b.last_name, b.relationship);
    },

    async delete_beneficiary(client_id: string, beneficiary_id: string): Promise<boolean> {
      log.info('delete_beneficiary', { client_id, beneficiary_id });
      await coreBankingApi();
      return store.deleteBeneficiary(client_id, beneficiary_id);
    },

    // -----------------------------------------------------------------------
    // Investments
    // -----------------------------------------------------------------------

    async list_investments(client_id: string): Promise<InvestmentRecord[]> {
      log.info('list_investments', { client_id });
      await coreBankingApi();
      return store.listInvestments(client_id);
    },

    async close_investment(client_id: string, investment_id: string): Promise<boolean> {
      log.info('close_investment', { client_id, investment_id });
      await coreBankingApi();
      return store.deleteInvestment(client_id, investment_id);
    },

    /** Business rules for a new account. Breaking one is non-retryable: the same request would fail again. */
    async validate_new_account(client_id: string, account_name: string, initial_amount: number): Promise<void> {
      log.info('validate_new_account', { client_id, account_name, initial_amount });
      checkDeposit(initial_amount);
    },

    /**
     * The promo code for a new account, if a promotion is running. The chaos panel's "Bug in workflow
     * code" switch runs the welcome-bonus promotion, whose code path in the open-account workflow has
     * a bug. The flag is read here, not in the workflow, which must be deterministic.
     */
    async find_promotion(client_id: string): Promise<string | null> {
      log.info('find_promotion', { client_id });
      return (await isEnabled(ChaosFlag.WORKFLOW_BUG)) ? WELCOME_BONUS_PROMO_CODE : null;
    },

    async open_investment(new_account: InvestmentAccount): Promise<InvestmentRecord> {
      log.info('open_investment', { ...new_account });
      await maybeSlowDown();
      await coreBankingApi();
      const record = await store.addInvestment(new_account);
      if (!record) {
        throw ApplicationFailure.nonRetryable(
          `Invalid opening balance ${formatUsd(new_account.balance)}`,
          'InvalidBalance',
        );
      }
      return record;
    },

    /**
     * Removes an investment account record: the saga's compensation for open_investment. An account
     * that is already gone counts as removed, so a retried compensation succeeds.
     */
    async remove_investment(client_id: string, investment_id: string): Promise<boolean> {
      log.info('remove_investment', { client_id, investment_id });
      await maybeSlowDown();
      await coreBankingApi();
      await store.deleteInvestment(client_id, investment_id);
      return true;
    },

    // -----------------------------------------------------------------------
    // Clients
    // -----------------------------------------------------------------------

    async get_client(client_id: string): Promise<WealthManagementClient | null> {
      log.info('get_client', { client_id });
      return store.getClient(client_id);
    },

    async update_client(client_id: string, field_dict: Partial<WealthManagementClient>): Promise<string> {
      log.info('update_client', { client_id, field_dict });
      return store.updateClient(client_id, field_dict);
    },

    // -----------------------------------------------------------------------
    // Funding: each call carries a transfer ID that is stable across retries, so a retried activity
    // never moves the money twice.
    // -----------------------------------------------------------------------

    async debit_linked_account(client_id: string, amount: number, transfer_id: string): Promise<Transfer> {
      log.info('debit_linked_account', { client_id, amount, transfer_id });
      await maybeSlowDown();
      try {
        return await store.debit(client_id, amount, transfer_id);
      } catch (err) {
        if (err instanceof InsufficientFundsError) {
          // A business-rule failure: retrying won't make the money appear
          throw ApplicationFailure.nonRetryable(err.message, INSUFFICIENT_FUNDS);
        }
        throw err;
      }
    },

    /** Refunds money to the linked bank account: the saga's compensation for debit_linked_account. */
    async credit_linked_account(client_id: string, amount: number, transfer_id: string): Promise<Transfer> {
      log.info('credit_linked_account', { client_id, amount, transfer_id });
      await maybeSlowDown();
      return store.credit(client_id, amount, transfer_id);
    },

    // -----------------------------------------------------------------------
    // Custodian: the third party that holds a new account's assets
    // -----------------------------------------------------------------------

    async register_account(client_id: string, investment_id: string, amount: number): Promise<string> {
      log.info('register_account', { client_id, investment_id, amount });
      await maybeSlowDown();
      await injectFailure(
        ChaosFlag.CUSTODIAN_REJECTS,
        ApplicationFailure.nonRetryable('The custodian rejected the account registration', CUSTODIAN_REJECTED),
      );
      return `CUST-${investment_id}`;
    },

    // -----------------------------------------------------------------------
    // Open account, chat side: these reach the open-account workflow through the Temporal client
    // -----------------------------------------------------------------------

    /** Runs the open-account workflow's get_client_details update, which waits until it has loaded them. */
    async get_current_client_info(workflow_id: string): Promise<WealthManagementClient | null> {
      const client = await deps.client();
      return client.workflow
        .getHandle(workflow_id)
        .executeUpdate<WealthManagementClient | null, []>(GET_CLIENT_DETAILS_UPDATE);
    },

    /** Sends the open-account workflow's verify_kyc signal. */
    async approve_kyc(workflow_id: string): Promise<void> {
      const client = await deps.client();
      await client.workflow.getHandle(workflow_id).signal(VERIFY_KYC_SIGNAL);
    },

    /** Runs the open-account workflow's update_client_details update with the changed fields. It completes KYC. */
    async update_client_details(workflow_id: string, client_details: Partial<WealthManagementClient>): Promise<string> {
      const client = await deps.client();
      return client.workflow
        .getHandle(workflow_id)
        .executeUpdate<string, [Partial<WealthManagementClient>]>(UPDATE_CLIENT_DETAILS_UPDATE, {
          args: [client_details],
        });
    },

    // -----------------------------------------------------------------------
    // Event stream: the conversation the UI polls (events:<workflow ID> in Redis)
    // -----------------------------------------------------------------------

    async append_chat_interaction(workflow_id: string, chat_interaction: ChatInteraction): Promise<number> {
      return events.append(workflow_id, { type: 'chat_interaction', content: chat_interaction });
    },

    async append_status_update(workflow_id: string, status_update: StatusUpdate): Promise<number> {
      return events.append(workflow_id, { type: 'status_update', content: status_update });
    },

    async delete_conversation(workflow_id: string): Promise<boolean> {
      return events.delete(workflow_id);
    },

    // -----------------------------------------------------------------------
    // Not part of the shared contract
    // -----------------------------------------------------------------------

    /** The worker's settings, for the chat workflow, which can't read the environment itself. */
    async get_worker_config(): Promise<WorkerConfig> {
      return deps.config;
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;
