/**
 * Client ID: once a tool has used the client ID, every agent is told it in its instructions, so none
 * asks for it again. Also checks a handoff happens in the same turn as the request.
 */
import assert from 'assert';
import { after, before, describe, it } from 'mocha';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import {
  getChatHistoryQuery,
  processUserMessageSignal,
  WealthManagementWorkflow,
} from '../durable/workflows/wealth-management';
import { createTestWorker, ScriptedLlm, waitFor } from './helpers';
import { CLIENT_ID_LINE, handoffScript } from './scripts';

describe('client ID and handoffs', function () {
  this.timeout(60_000);
  let env: TestWorkflowEnvironment;

  before(async () => {
    env = await TestWorkflowEnvironment.createLocal();
  });
  after(async () => {
    await env?.teardown();
  });

  it('tells every agent the client ID once a tool used it, and hands off in the same turn', async () => {
    ScriptedLlm.script = handoffScript;
    ScriptedLlm.requests = [];
    const t = await createTestWorker(env);
    await t.worker.runUntil(async () => {
      const handle = await env.client.workflow.start(WealthManagementWorkflow, {
        taskQueue: t.taskQueue,
        workflowId: `client-id-${Date.now()}`,
      });
      const send = async (text: string, n: number) => {
        await handle.signal(processUserMessageSignal, { user_input: text });
        return waitFor(async () => {
          const h = await handle.query(getChatHistoryQuery);
          return h.length >= n ? h[n - 1] : undefined;
        });
      };

      const first = await send('Who are my beneficiaries?', 1);
      assert.match(first.text_response, /client ID/);

      const second = await send('123', 2);
      assert.match(second.text_response, /John Doe/);

      const before = ScriptedLlm.requests.length;
      const third = await send('What investments do I have?', 3);
      assert.match(third.text_response, /Checking, Savings and 401K/);
      assert.match(third.agent_trace, /Handed off from Beneficiary_Agent to Supervisor_Agent/);
      assert.match(third.agent_trace, /Handed off from Supervisor_Agent to Investment_Agent/);
      // Every agent that ran after the client ID was used was told it
      for (const req of ScriptedLlm.requests.slice(before)) {
        assert.ok(req.instructions.includes(CLIENT_ID_LINE), `${req.agent} was not told the client ID`);
      }
      // The event stream got one chat_interaction per message
      const events = await t.events.getEventsFromIndex(handle.workflowId, 0);
      assert.strictEqual(events.filter((e) => e.type === 'chat_interaction').length, 3);
    });
  });
});
