/**
 * The chat workflow with the scripted model: handoffs, the trace, the model calls on their own task queue,
 * the conversation staying with the agent that answered last, the client ID in the instructions, the KYC
 * guard and the business-rule refusal.
 */
import assert from 'assert';
import { after, before, describe, it } from 'mocha';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { STATE_WAITING_COMPLIANCE, STATE_WAITING_KYC } from '../durable/shared';
import {
  KYC_NOT_APPROVED,
  kycConfirmed,
  WealthManagementWorkflow,
  withClientId,
} from '../durable/workflows/wealth-management';
import { chatSender, createTestWorker, openingStates, ScriptedModel, TestWorker, waitFor } from './helpers';
import { demoScript } from './scripts';

describe('chat workflow', function () {
  this.timeout(90_000);
  let env: TestWorkflowEnvironment;

  before(async () => {
    env = await TestWorkflowEnvironment.createLocal();
  });
  after(async () => {
    await env?.teardown();
  });

  async function startChat(t: TestWorker, name: string) {
    const handle = await env.client.workflow.start(WealthManagementWorkflow, {
      taskQueue: t.taskQueue,
      workflowId: `${name}-${Date.now()}`,
    });
    return { handle, send: chatSender(handle) };
  }

  it('hands off to the beneficiary agent, and records the handoff and tool calls', async () => {
    ScriptedModel.reset(demoScript());
    const t = await createTestWorker(env);
    await t.runUntil(async () => {
      const { send } = await startChat(t, 'beneficiaries');
      const reply = await send('Who are my beneficiaries?');
      assert.match(reply.text_response, /John/);
      assert.match(reply.json_response, /b-1b011a72/);
      assert.deepStrictEqual(reply.agent_trace.trim().split('\n'), [
        'Handed off from Supervisor Agent to Beneficiary Agent',
        'Beneficiary Agent: Calling a tool: list_beneficiaries',
      ]);
    });
  });

  it('runs every model call as an activity on the model task queue', async () => {
    ScriptedModel.reset(demoScript());
    const t = await createTestWorker(env);
    await t.runUntil(async () => {
      const { handle, send } = await startChat(t, 'llm-queue');
      await send('What investments do I have?');
      assert.strictEqual(ScriptedModel.calls.length, 3);
      for (const c of ScriptedModel.calls) {
        assert.strictEqual(c.taskQueue, t.llmTaskQueue);
        assert.strictEqual(c.workflowId, handle.workflowId);
      }
      assert.deepStrictEqual(
        ScriptedModel.calls.map((c) => c.agent),
        ['supervisor', 'investment', 'investment'],
      );
    });
  });

  it('keeps the conversation with the agent that answered last, which hands back for anything else', async () => {
    ScriptedModel.reset(demoScript());
    const t = await createTestWorker(env);
    await t.runUntil(async () => {
      const { send } = await startChat(t, 'last-agent');
      await send('Who are my beneficiaries?');
      ScriptedModel.reset(demoScript());
      const again = await send('Who are my beneficiaries again?');
      // Straight to the beneficiary agent, which still has the first turn in its history
      assert.strictEqual(ScriptedModel.requests[0].agent, 'beneficiary');
      assert.strictEqual(ScriptedModel.requests[0].allResults.filter((r) => r.includes('b-1b011a72')).length, 1);
      assert.match(again.agent_trace, /^Beneficiary Agent: Calling a tool: list_beneficiaries/);

      const investments = await send('What investments do I have?');
      assert.deepStrictEqual(investments.agent_trace.trim().split('\n'), [
        'Handed off from Beneficiary Agent to Supervisor Agent',
        'Handed off from Supervisor Agent to Investment Agent',
        'Investment Agent: Calling a tool: list_investments',
      ]);
    });
  });

  it("puts the client ID in every agent's instructions once a tool was called with it", async () => {
    assert.strictEqual(withClientId('Help.', undefined), 'Help.');
    assert.match(
      withClientId('Help.', '123'),
      /The customer's client ID is 123\. Use it, and don't ask for it again\.$/,
    );

    ScriptedModel.reset(demoScript());
    const t = await createTestWorker(env);
    await t.runUntil(async () => {
      const { send } = await startChat(t, 'client-id');
      await send('Who are my beneficiaries?');
      const [supervisor, beforeTool, afterTool] = ScriptedModel.requests;
      assert.doesNotMatch(supervisor.systemPrompt, /client ID is 123/);
      assert.doesNotMatch(beforeTool.systemPrompt, /client ID is 123/);
      assert.match(afterTool.systemPrompt, /client ID is 123/);
      await send('What investments do I have?');
      for (const r of ScriptedModel.requests.slice(3)) assert.match(r.systemPrompt, /client ID is 123/);
    });
  });

  it('deletes a beneficiary through the agent the conversation stayed with', async () => {
    ScriptedModel.reset(demoScript());
    const t = await createTestWorker(env);
    await t.runUntil(async () => {
      const { send } = await startChat(t, 'delete');
      await send('Who are my beneficiaries?');
      const yes = await send('Yes, delete John');
      assert.match(yes.text_response, /Beneficiary deleted/);
      assert.strictEqual((await t.store.listBeneficiaries('123')).length, 2);
    });
  });

  describe('KYC guard', () => {
    it('approves only once the details were shown in an earlier turn', () => {
      assert.ok(!kycConfirmed(undefined, 3));
      assert.ok(!kycConfirmed(3, 3));
      assert.ok(kycConfirmed(2, 3));
    });

    it('does not approve KYC in the turn the details were fetched, and does once the customer confirms', async () => {
      // The open-account agent tries to approve KYC right after fetching the details
      ScriptedModel.reset(demoScript(true));
      const t = await createTestWorker(env);
      await t.runUntil(async () => {
        const { handle, send } = await startChat(t, 'kyc');
        const opening = `OpenAccount-${handle.workflowId}-123-Vacation-1`;
        const reply = await send('Open Vacation with $500');
        assert.match(reply.json_response, /Don/);
        assert.ok(reply.json_response.includes(KYC_NOT_APPROVED));
        assert.match(reply.agent_trace, /Handed off from Investment Agent to Open Account Agent/);
        await waitFor(async () => ((await openingStates(handle))[opening] === STATE_WAITING_KYC ? true : undefined));
        await new Promise((r) => setTimeout(r, 500));
        assert.strictEqual(
          await env.client.workflow.getHandle(opening).query<string>('get_current_state'),
          STATE_WAITING_KYC,
        );

        const yes = await send('Yes, that is correct');
        assert.match(yes.text_response, /KYC approved/);
        // Straight to the open-account agent, which kept the conversation
        assert.match(yes.agent_trace, /^Open Account Agent: Calling a tool: approve_kyc/);
        await waitFor(async () =>
          (await openingStates(handle))[opening] === STATE_WAITING_COMPLIANCE ? true : undefined,
        );
        const status = await send('What is the status?');
        assert.match(status.text_response, new RegExp(STATE_WAITING_COMPLIANCE));
      });
    });
  });

  it('refuses a deposit outside $100 to $1,000,000 before any workflow starts, and explains why', async () => {
    ScriptedModel.reset(demoScript());
    const t = await createTestWorker(env);
    await t.runUntil(async () => {
      const { handle, send } = await startChat(t, 'business-rule');
      const big = await send('Open Yacht with $2,000,000');
      assert.match(big.text_response, /cannot be opened: Initial deposits over \$1,000,000\.00/);
      const small = await send('Open Piggy with $50');
      assert.match(small.text_response, /cannot be opened: The initial deposit must be at least \$100\.00/);
      assert.deepStrictEqual(await openingStates(handle), {});
      // A refused request doesn't use up a number: the next opening is -1
      await send('Open Vacation with $500');
      assert.ok(`OpenAccount-${handle.workflowId}-123-Vacation-1` in (await openingStates(handle)));
    });
  });
});
