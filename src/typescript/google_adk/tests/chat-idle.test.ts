/**
 * Idle chat: with no customer message and no account-opening status update for CHAT_IDLE_TIMEOUT
 * (1 hour), the WealthManagementWorkflow completes by itself, as it does on End Chat.
 *
 * Runs on the SDK's time-skipping test server, so the hour passes instantly. The model is never
 * called.
 */
import assert from 'assert';
import { after, before, describe, it } from 'mocha';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { WealthManagementWorkflow } from '../durable/workflows/wealth-management';
import { createTestWorker, ScriptedLlm } from './helpers';

const HOUR_MS = 60 * 60 * 1000;

describe('idle chat', function () {
  this.timeout(60_000);
  let env: TestWorkflowEnvironment;

  before(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
  });
  after(async () => {
    await env?.teardown();
  });

  it('completes by itself after an hour without customer messages or status updates', async () => {
    ScriptedLlm.requests = [];
    const t = await createTestWorker(env);
    await t.worker.runUntil(async () => {
      const handle = await env.client.workflow.start(WealthManagementWorkflow, {
        taskQueue: t.taskQueue,
        workflowId: `chat-idle-${Date.now()}`,
      });

      // Still waiting for the customer a minute before the timeout
      await env.sleep('59 minutes');
      assert.strictEqual((await handle.describe()).status.name, 'RUNNING');

      // Then it ends by itself, normally
      await handle.result();
      const description = await handle.describe();
      assert.strictEqual(description.status.name, 'COMPLETED');
      assert.ok(description.closeTime!.getTime() - description.startTime.getTime() >= HOUR_MS);
      assert.strictEqual(ScriptedLlm.requests.length, 0);
    });
  });
});
