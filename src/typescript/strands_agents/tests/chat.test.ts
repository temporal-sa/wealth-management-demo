/**
 * The chat workflow with the scripted model: agents as tools, the trace, the model calls on their own task
 * queue, the sub-agents' memory across turns, the confirmation guard and the KYC guard.
 */
import assert from 'assert';
import { after, before, describe, it } from 'mocha';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { STATE_WAITING_COMPLIANCE, STATE_WAITING_KYC } from '../durable/shared';
import {
  confirmed,
  KYC_NOT_APPROVED,
  kycConfirmed,
  notConfirmed,
  WealthManagementWorkflow,
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

  it('delegates to the beneficiary agent as a tool, and records the handoff and tool calls', async () => {
    ScriptedModel.reset(demoScript());
    const t = await createTestWorker(env);
    await t.runUntil(async () => {
      const { send } = await startChat(t, 'beneficiaries');
      const reply = await send('Who are my beneficiaries?');
      assert.match(reply.text_response, /John/);
      assert.match(reply.json_response, /b-1b011a72/);
      assert.deepStrictEqual(reply.agent_trace.trim().split('\n'), [
        'Supervisor Agent: Calling a tool: beneficiary_assistant',
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
      assert.ok(ScriptedModel.calls.length >= 4);
      for (const c of ScriptedModel.calls) {
        assert.strictEqual(c.taskQueue, t.llmTaskQueue);
        assert.strictEqual(c.workflowId, handle.workflowId);
      }
      assert.deepStrictEqual([...new Set(ScriptedModel.calls.map((c) => c.agent))].sort(), [
        'investment',
        'supervisor',
      ]);
    });
  });

  it('keeps each sub-agent for the whole chat, so it remembers earlier turns', async () => {
    ScriptedModel.reset(demoScript());
    const t = await createTestWorker(env);
    await t.runUntil(async () => {
      const { send } = await startChat(t, 'memory');
      await send('Who are my beneficiaries?');
      await send('Who are my beneficiaries again?');
      const second = ScriptedModel.requests.filter((r) => r.agent === 'beneficiary').pop()!;
      // The beneficiary agent's history still holds the first turn's tool result
      assert.strictEqual(second.allResults.filter((r) => r.includes('b-1b011a72')).length, 2);
    });
  });

  describe('confirmation guard', () => {
    it('allows a delete or close only when the customer was asked in the previous turn', () => {
      assert.ok(!confirmed(undefined, 2));
      assert.ok(!confirmed(2, 2));
      assert.ok(confirmed(1, 2));
      assert.ok(!confirmed(1, 3));
      assert.match(notConfirmed('delete_beneficiary'), /Are you sure you want to delete beneficiary/);
    });

    it('refuses the delete until the customer says yes in the next message', async () => {
      ScriptedModel.reset(demoScript());
      const t = await createTestWorker(env);
      await t.runUntil(async () => {
        const { send } = await startChat(t, 'confirm');
        const asked = await send('Delete beneficiary John Doe');
        assert.match(asked.text_response, /Not done: the customer has not confirmed this yet/);
        assert.strictEqual((await t.store.listBeneficiaries('123')).length, 3);
        const yes = await send('Yes, delete him');
        assert.match(yes.text_response, /Beneficiary deleted/);
        assert.strictEqual((await t.store.listBeneficiaries('123')).length, 2);
      });
    });

    it('asks again when the yes does not come in the very next message', async () => {
      ScriptedModel.reset(demoScript());
      const t = await createTestWorker(env);
      await t.runUntil(async () => {
        const { send } = await startChat(t, 'confirm-late');
        await send('Delete beneficiary John Doe');
        await send('What investments do I have?');
        const late = await send('Yes, delete beneficiary John Doe');
        assert.match(late.text_response, /Not done/);
        assert.strictEqual((await t.store.listBeneficiaries('123')).length, 3);
      });
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
        await waitFor(async () =>
          (await openingStates(handle))[opening] === STATE_WAITING_COMPLIANCE ? true : undefined,
        );
      });
    });

    it('tells the open-account agent the current status of each opening on every request', async () => {
      ScriptedModel.reset(demoScript());
      const t = await createTestWorker(env);
      await t.runUntil(async () => {
        const { send } = await startChat(t, 'summary');
        await send('Open Vacation with $500');
        await send('Yes');
        const last = ScriptedModel.requests.filter((r) => r.agent === 'open-account').pop()!;
        assert.match(
          last.lastUserText,
          /^The client ID is 123\. Current status of account openings in this conversation: Vacation/,
        );
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
