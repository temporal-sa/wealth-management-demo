/**
 * Scripted conversations for the default suite. Each stands in for the model: it reads the request
 * the agents send and answers with text, a tool call or a transfer.
 */
import {
  BENE_AGENT_NAME,
  INVEST_AGENT_NAME,
  OPEN_ACCOUNT_AGENT_NAME,
  SUPERVISOR_AGENT_NAME,
} from '../prompts/agent-constants';
import { call, say, Script, ScriptedRequest, transfer } from './helpers';

export const CLIENT_ID_LINE = "The customer's client ID is 123.";
const OPEN_REQUEST = /open (\w+) with \$([\d,.]+)/i;

/** A function response's value: ADK wraps a tool's non-object result as {result}. */
function resultOf(response: Record<string, unknown>): unknown {
  return 'result' in response ? response.result : response;
}

/** Every function response this agent got in the conversation, oldest first. */
function allResponses(req: ScriptedRequest): Array<{ name: string; value: unknown }> {
  return req.contents.flatMap((c) =>
    (c.parts ?? [])
      .filter((p) => p.functionResponse)
      .map((p) => ({
        name: p.functionResponse!.name ?? '',
        value: resultOf((p.functionResponse!.response ?? {}) as Record<string, unknown>),
      })),
  );
}

/** The workflow ID of the latest account opening this agent started. */
export function latestOpening(req: ScriptedRequest): string | undefined {
  const opened = allResponses(req).filter(
    (r) => r.name === 'open_new_investment_account' && String(r.value).startsWith('OpenAccount-'),
  );
  return opened.length ? String(opened[opened.length - 1].value) : undefined;
}

function thisTurn(req: ScriptedRequest, name: string): unknown {
  const r = req.responsesThisTurn.filter((x) => x.name === name);
  return r.length ? resultOf(r[r.length - 1].response) : undefined;
}

/** The handoff conversation: beneficiaries, the client ID, then investments. */
export const handoffScript: Script = (req) => {
  const text = req.lastUserText.toLowerCase();
  switch (req.agent) {
    case SUPERVISOR_AGENT_NAME:
      if (text.includes('investment') || OPEN_REQUEST.test(text)) return transfer(INVEST_AGENT_NAME);
      if (text.includes('beneficiar') || text === '123') return transfer(BENE_AGENT_NAME);
      return say('I can only help with beneficiaries and investment accounts. How can I help with those?');
    case BENE_AGENT_NAME:
      if (text.includes('investment') || OPEN_REQUEST.test(text)) return transfer(SUPERVISOR_AGENT_NAME);
      if (text === '123') {
        if (thisTurn(req, 'list_beneficiaries')) return say('Your beneficiaries are John Doe, Jane Doe and Joe Doe.');
        return call('list_beneficiaries', { client_id: '123' });
      }
      return say('What is your client ID?');
    case INVEST_AGENT_NAME:
      if (OPEN_REQUEST.test(text)) return transfer(OPEN_ACCOUNT_AGENT_NAME);
      if (thisTurn(req, 'list_investments')) return say('You have Checking, Savings and 401K accounts.');
      return req.instructions.includes(CLIENT_ID_LINE)
        ? call('list_investments', { client_id: '123' })
        : say('What is your client ID?');
    case OPEN_ACCOUNT_AGENT_NAME:
      return openAccountScript(req);
    default:
      return say('Sorry?');
  }
};

/**
 * The Open Account Agent: "Open <name> with $<amount>" starts an opening and shows the details;
 * "Yes" approves KYC for the latest opening. With `approveRightAway`, it also tries to approve KYC
 * in the same turn it fetched the details, which the KYC guard must refuse.
 */
export function openAccountScript(req: ScriptedRequest, approveRightAway = false): ReturnType<Script> {
  const text = req.lastUserText;
  const m = OPEN_REQUEST.exec(text);
  if (m) {
    const opened = thisTurn(req, 'open_new_investment_account');
    if (opened === undefined) {
      return call('open_new_investment_account', {
        client_id: '123',
        account_name: m[1],
        initial_amount: Number(m[2].replace(/,/g, '')),
      });
    }
    if (!String(opened).startsWith('OpenAccount-')) return say(String(opened));
    const details = thisTurn(req, 'get_current_client_info') as Record<string, string> | undefined;
    if (!details) return call('get_current_client_info', { workflow_id: opened });
    if (approveRightAway && thisTurn(req, 'approve_kyc') === undefined) {
      return call('approve_kyc', { workflow_id: opened });
    }
    return say(
      `Your details: ${details.first_name} ${details.last_name}, ${details.address}, ${details.phone}, ` +
        `${details.email}, ${details.marital_status}. Is this correct?`,
    );
  }
  if (/^yes/i.test(text)) {
    const approved = thisTurn(req, 'approve_kyc');
    if (approved !== undefined) return say(String(approved));
    return call('approve_kyc', { workflow_id: latestOpening(req) });
  }
  if (/status/i.test(text)) {
    const status = thisTurn(req, 'get_account_opening_status');
    if (status !== undefined) return say(`Status: ${String(status)}`);
    return call('get_account_opening_status', { workflow_id: latestOpening(req) });
  }
  return transfer(INVEST_AGENT_NAME);
}
