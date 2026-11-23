/**
 * Scripts for the scripted model: each agent does what the demo's agents do, with no model.
 *
 * The supervisor hands a beneficiary message to the beneficiary agent and anything else to the investment
 * agent. The other agents pick a tool from the customer's words and answer with the tool's result, and hand
 * the conversation back when the customer asks for something they don't handle.
 */
import {
  call,
  say,
  TO_BENEFICIARY,
  TO_INVESTMENT,
  TO_OPEN_ACCOUNT,
  TO_SUPERVISOR,
  type ScriptedRequest,
  type ScriptStep,
} from './helpers';

const lastResult = (req: ScriptedRequest) => req.resultsThisTurn[req.resultsThisTurn.length - 1];
const aboutBeneficiaries = (text: string) => /beneficiar/i.test(text);

/** The workflow ID of the latest account opening in the conversation. */
export function latestOpening(req: ScriptedRequest): string | undefined {
  const ids = req.allResults.flatMap((r) => [...r.matchAll(/Workflow ID: (\S+)/g)].map((m) => m[1]));
  return ids[ids.length - 1];
}

function supervisor(req: ScriptedRequest): ScriptStep {
  return call(aboutBeneficiaries(req.lastUserText) ? TO_BENEFICIARY : TO_INVESTMENT);
}

function beneficiary(req: ScriptedRequest): ScriptStep {
  if (req.resultsThisTurn.length > 0) return say(lastResult(req));
  const text = req.lastUserText;
  if (/delete|yes/i.test(text)) {
    return call('delete_beneficiary', { client_id: '123', beneficiary_id: 'b-1b011a72' });
  }
  if (!aboutBeneficiaries(text)) return call(TO_SUPERVISOR);
  return call('list_beneficiaries', { client_id: '123' });
}

function investment(req: ScriptedRequest): ScriptStep {
  if (req.resultsThisTurn.length > 0) return say(lastResult(req));
  const text = req.lastUserText;
  if (aboutBeneficiaries(text)) return call(TO_SUPERVISOR);
  if (/close/i.test(text)) return call('close_investment', { client_id: '123', investment_id: 'i-1' });
  if (/open|yes/i.test(text)) return call(TO_OPEN_ACCOUNT);
  return call('list_investments', { client_id: '123' });
}

/**
 * The open-account agent: starts an opening, shows the details, and approves KYC when the customer says yes.
 * With `eager`, it also tries to approve KYC in the turn it shows the details, which the KYC guard refuses.
 */
export function openAccount(req: ScriptedRequest, eager = false): ScriptStep {
  const results = req.resultsThisTurn;
  const opening = latestOpening(req);
  const open = req.lastUserText.match(/Open (\w+) with \$([\d,]+)/);
  if (open) {
    if (results.length === 0) {
      return call('open_new_investment_account', {
        client_id: '123',
        account_name: open[1],
        initial_amount: Number(open[2].replace(/,/g, '')),
      });
    }
    if (results.length === 1 && results[0].includes('Workflow ID')) {
      return call('get_current_client_info', { workflow_id: opening });
    }
    if (results.length === 2 && eager) return call('approve_kyc', { workflow_id: opening });
    return say(results.join('\n'));
  }
  if (/yes/i.test(req.lastUserText) && opening) {
    return results.length === 0 ? call('approve_kyc', { workflow_id: opening }) : say(lastResult(req));
  }
  if (/status/i.test(req.lastUserText) && opening) {
    return results.length === 0 ? call('get_account_opening_status', { workflow_id: opening }) : say(lastResult(req));
  }
  return call(TO_INVESTMENT);
}

/** Every agent, with the open-account agent as `openAccount(req, eager)`. */
export function demoScript(eager = false) {
  return (req: ScriptedRequest): ScriptStep => {
    switch (req.agent) {
      case 'supervisor':
        return supervisor(req);
      case 'beneficiary':
        return beneficiary(req);
      case 'investment':
        return investment(req);
      case 'open-account':
        return openAccount(req, eager);
      default:
        return say('Hello');
    }
  };
}
