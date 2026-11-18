/**
 * The shared Temporal contract: workflow, signal, query, update and activity names and payloads.
 * They match the reference port exactly (snake_case even in TypeScript), so the scripts, the shared
 * UI and the Java open-account worker work with every port.
 *
 * No module imports here, so workflow code can use this file.
 */

export const WEALTH_MANAGEMENT_WORKFLOW = 'WealthManagementWorkflow';
export const OPEN_INVESTMENT_ACCOUNT_WORKFLOW = 'OpenInvestmentAccountWorkflow';

// WealthManagementWorkflow
export const PROCESS_USER_MESSAGE_SIGNAL = 'process_user_message';
export const END_WORKFLOW_SIGNAL = 'end_workflow';
export const UPDATE_ACCOUNT_OPENING_STATE_SIGNAL = 'update_account_opening_state';
export const GET_CHAT_HISTORY_QUERY = 'get_chat_history';
/** Not part of the shared contract: the latest state of each account opening, for the tests. */
export const GET_ACCOUNT_OPENING_STATES_QUERY = 'get_account_opening_states';

// OpenInvestmentAccountWorkflow
export const GET_CURRENT_STATE_QUERY = 'get_current_state';
export const GET_CLIENT_DETAILS_UPDATE = 'get_client_details';
export const UPDATE_CLIENT_DETAILS_UPDATE = 'update_client_details';
export const VERIFY_KYC_SIGNAL = 'verify_kyc';
export const COMPLIANCE_APPROVED_SIGNAL = 'compliance_approved';

export interface ProcessUserMessageInput {
  user_input: string;
}

/** Sent by an open-account workflow to its parent on every state change. */
export interface UpdateAccountOpeningStateInput {
  account_name: string;
  state: string;
  workflow_id: string | null;
}

/** The status text shown in the UI when an account opening changes state. */
export function accountStatusText(accountName: string, state: string): string {
  return `New ${accountName} account status changed: ${state}`;
}

export interface ChatInteraction {
  user_prompt: string;
  text_response: string;
  json_response: string;
  agent_trace: string;
}

export interface StatusUpdate {
  status: string;
}

export interface OpenInvestmentAccountInput {
  client_id: string;
  account_name: string;
  initial_amount: number;
  promo_code: string | null;
}

export interface OpenInvestmentAccountOutput {
  account_created: boolean;
  message: string;
}

// Open-account states reported to the parent
export const STATE_INITIALIZING = 'Initializing';
export const STATE_WAITING_KYC = 'Waiting KYC';
export const STATE_WAITING_COMPLIANCE = 'Waiting Compliance Review';
export const STATE_COMPLIANCE_APPROVED = 'Compliance review has been approved. Creating Investment Account';
export const STATE_CREATING_RECORD = 'Creating the account record.';
export const STATE_REGISTERING = 'Registering the account with the custodian.';
export const STATE_COMPLETE = 'Complete';

// Business failures: non-retryable ApplicationFailure types
export const DEPOSIT_BELOW_MINIMUM = 'DepositBelowMinimum';
export const DEPOSIT_LIMIT_EXCEEDED = 'DepositLimitExceeded';
export const INSUFFICIENT_FUNDS = 'InsufficientFunds';
export const CUSTODIAN_REJECTED = 'CustodianRejected';

export const MIN_INITIAL_DEPOSIT = 100;
export const MAX_INITIAL_DEPOSIT = 1_000_000;
export const WELCOME_BONUS_PROMO_CODE = 'WELCOME-BONUS';
