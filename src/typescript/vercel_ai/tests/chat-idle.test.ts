// A chat nobody uses ends by itself: with no customer message and no account-opening status update
// for CHAT_IDLE_TIMEOUT (1 hour), the WealthManagementWorkflow completes, and clears its
// conversation as it does on End Chat.
//
// Runs the real workflow on the SDK's time-skipping test server (downloaded automatically on first
// run), so the hour passes instantly. No Gemini API key or Redis needed: the model is never called.
import assert from 'assert';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { AiSdkPlugin } from '@temporalio/vercel-ai-sdk';
import type { ProviderV4 } from '@ai-sdk/provider';
import { WealthManagementWorkflow } from './kyc-guard-workflows';

const HOUR_MS = 60 * 60 * 1000;

function noModel(): never {
  throw new Error('an idle chat must not call the model');
}

describe('Idle chat', function () {
  this.timeout(120_000);
  const TASK_QUEUE = 'chat-idle-test';
  let env: TestWorkflowEnvironment;

  before(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
  });

  after(async () => {
    await env?.teardown();
  });

  it('completes by itself after an hour without customer messages or status updates', async () => {
    const deletedConversations: string[] = [];
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowsPath: require.resolve('./kyc-guard-workflows'),
      plugins: [new AiSdkPlugin({
        modelProvider: { specificationVersion: 'v4', languageModel: noModel, embeddingModel: noModel, imageModel: noModel } as ProviderV4,
      })],
      bundlerOptions: { ignoreModules: ['@temporalio/activity', '@temporalio/client', 'crypto'] },
      activities: {
        async delete_conversation(workflowId: string) {
          deletedConversations.push(workflowId);
          return true;
        },
      },
    });

    await worker.runUntil(async () => {
      const workflowId = `chat-idle-${Math.random().toString(36).slice(2)}`;
      const handle = await env.client.workflow.start(WealthManagementWorkflow, { taskQueue: TASK_QUEUE, workflowId });

      // Still waiting for the customer a minute before the timeout
      await env.sleep('59 minutes');
      assert.strictEqual((await handle.describe()).status.name, 'RUNNING');

      // Then it ends by itself, normally, clearing the conversation as End Chat does
      await handle.result();
      const description = await handle.describe();
      assert.strictEqual(description.status.name, 'COMPLETED');
      assert.ok(description.closeTime!.getTime() - description.startTime.getTime() >= HOUR_MS);
      assert.deepStrictEqual(deletedConversations, [workflowId, workflowId]);
    });
  });
});
