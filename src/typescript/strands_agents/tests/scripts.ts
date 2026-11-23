/**
 * Scripts for the scripted model: each agent does what the demo's agents do, with no model.
 *
 * The supervisor hands a beneficiary message to the beneficiary assistant and anything else to the investment
 * assistant, then repeats what the assistant said. The sub-agents pick a tool from the request's words and
 * answer with the tool's result.
 */
import { call, say, type ScriptedRequest, type ScriptStep } from './helpers';

const lastResult = (req: ScriptedRequest) => req.resultsThisTurn[req.resultsThisTurn.length - 1];

/** The workflow ID of the latest account opening this agent started. */
export function latestOpening(req: ScriptedRequest): string | undefined {
  const ids = req.allResults.flatMap((r) => [...r.matchAll(/Workflow ID: (\S+)/g)].map((m) => m[1]));
  return ids[ids.length - 1];
}

function supervisor(req: ScriptedRequest): ScriptStep {
  if (req.resultsThisTurn.length > 0) return say(lastResult(req));
  const tool = /beneficiar|delete/i.test(req.lastUserText) ? 'beneficiary_assistant' : 'investment_assistant';
  return call(tool, { client_id: '123', request: req.lastUserText });
}

function beneficiary(req: ScriptedRequest): ScriptStep {
  if (req.resultsThisTurn.length > 0) return say(lastResult(req));
  if (/delete|yes/i.test(req.lastUserText)) {
    return call('delete_beneficiary', { client_id: '123', beneficiary_id: 'b-1b011a72' });
  }
  return call('list_beneficiaries', { client_id: '123' });
}

function investment(req: ScriptedRequest): ScriptStep {
  if (req.resultsThisTurn.length > 0) return say(lastResult(req));
  const text = req.lastUserText;
  if (/close|sure/i.test(text)) return call('close_investment', { client_id: '123', investment_id: 'i-1' });
  if (/open|yes/i.test(text)) return call('open_account_assistant', { client_id: '123', request: text });
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
  return say('What would you like to name the account?');
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
