/**
 * Repeat opening: two "Vacation" openings in one chat start ...-Vacation-1 and ...-Vacation-2, both
 * run, and the second needs its own KYC.
 */
import assert from 'assert';
import { after, before, describe, it } from 'mocha';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { STATE_WAITING_COMPLIANCE, STATE_WAITING_KYC } from '../durable/shared';
import { WealthManagementWorkflow } from '../durable/workflows/wealth-management';
import { chatSender, createTestWorker, openingStates, ScriptedLlm, waitFor } from './helpers';
import { handoffScript } from './scripts';

describe('repeat opening', function () {
  this.timeout(90_000);
  let env: TestWorkflowEnvironment;

  before(async () => {
    env = await TestWorkflowEnvironment.createLocal();
  });
  after(async () => {
    await env?.teardown();
  });

  it('starts a new numbered opening, with its own KYC, for every request', async () => {
    ScriptedLlm.script = handoffScript;
    const t = await createTestWorker(env);
    await t.worker.runUntil(async () => {
      const chatId = `repeat-${Date.now()}`;
      const handle = await env.client.workflow.start(WealthManagementWorkflow, {
        taskQueue: t.taskQueue,
        workflowId: chatId,
      });
      const send = chatSender(handle);
      await send('Who are my beneficiaries?');
      await send('123');
      await send('What investments do I have?');

      const first = await send('Open Vacation with $13,000');
      assert.match(first.text_response, /Don/);
      assert.match(first.text_response, /123 Main Street/);
      const firstId = `OpenAccount-${chatId}-123-Vacation-1`;

      const yes = await send('Yes');
      assert.match(yes.text_response, /KYC approved/);
      await waitFor(async () =>
        (await openingStates(handle))[firstId] === STATE_WAITING_COMPLIANCE ? true : undefined,
      );

      const second = await send('Open Vacation with $13,000');
      assert.match(second.text_response, /Don/);
      assert.match(second.text_response, /123 Main Street/);
      const secondId = `OpenAccount-${chatId}-123-Vacation-2`;

      // Both are running, and the second waits for its own KYC
      const states = await waitFor(async () => {
        const s = await openingStates(handle);
        return s[secondId] === STATE_WAITING_KYC ? s : undefined;
      });
      assert.strictEqual(states[firstId], STATE_WAITING_COMPLIANCE);
      for (const id of [firstId, secondId]) {
        const d = await env.client.workflow.getHandle(id).describe();
        assert.strictEqual(d.status.name, 'RUNNING', id);
      }
    });
  });
});
