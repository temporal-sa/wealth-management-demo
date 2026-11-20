/**
 * Failure scenarios: retries through a tool and a model outage, the 429 retry delay, the chaos flags read for
 * the chat's own browser session inside the model activity, the saga's success, its rollback after a
 * custodian rejection and after insufficient funds, and the bug in workflow code pausing the workflow without
 * failing it.
 */
import assert from 'assert';
import { after, before, describe, it } from 'mocha';
import type { WorkflowHandle } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import type Redis from 'ioredis';
import { ChaosFlag, ChaosManager, flagsKey } from '../../common/chaos-manager';
import { newChatWorkflowId, newSessionId } from '../../common/session-scope';
import { OpenInvestmentAccountInput, PROCESS_USER_MESSAGE_SIGNAL, STATE_COMPLETE } from '../durable/shared';
import {
  complianceApprovedSignal,
  getCurrentStateQuery,
  OpenInvestmentAccountWorkflow,
  verifyKycSignal,
} from '../durable/workflows/open-account';
import { WealthManagementWorkflow } from '../durable/workflows/wealth-management';
import { chatSender, createTestWorker, openingStates, ScriptedModel, TestWorker, waitFor } from './helpers';
import { demoScript } from './scripts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The activity types the workflow scheduled, in order. */
async function scheduledActivities(handle: WorkflowHandle): Promise<string[]> {
  const { events } = await handle.fetchHistory();
  return (events ?? [])
    .map((e) => e.activityTaskScheduledEventAttributes?.activityType?.name)
    .filter((n): n is string => !!n);
}

/** The chaos flags as the worker keeps them in Redis (chaos:<session>:flags), in memory. */
class FakeChaosRedis {
  readonly hashes = new Map<string, Record<string, string>>();
  async hget(key: string, field: string): Promise<string | null> {
    return this.hashes.get(key)?.[field] ?? null;
  }
  turnOn(session: string, flag: ChaosFlag): void {
    this.hashes.set(flagsKey(session), { ...this.hashes.get(flagsKey(session)), [flag]: '1' });
  }
}

describe('failure scenarios', function () {
  this.timeout(120_000);
  let env: TestWorkflowEnvironment;

  before(async () => {
    env = await TestWorkflowEnvironment.createLocal();
  });
  after(async () => {
    await env?.teardown();
  });

  // -------------------------------------------------------------------------
  // In the chat
  // -------------------------------------------------------------------------

  async function startChat(t: TestWorker, name: string, workflowId = `${name}-${Date.now()}`) {
    ScriptedModel.reset(demoScript());
    const handle = await env.client.workflow.start(WealthManagementWorkflow, { taskQueue: t.taskQueue, workflowId });
    return { handle, send: chatSender(handle, 60_000) };
  }

  it('waits out a core banking outage mid-turn, and nothing is lost or asked again', async () => {
    const t = await createTestWorker(env);
    await t.runUntil(async () => {
      const { handle, send } = await startChat(t, 'tool-down');
      t.chaos.set(ChaosFlag.TOOL_DOWN, true);
      const reply = send('Who are my beneficiaries?');
      await waitFor(async () => (t.chaos.events.some((e) => e.source === 'list_beneficiaries') ? true : undefined));
      await sleep(1500);
      assert.strictEqual((await handle.query<unknown[]>('get_chat_history')).length, 0, 'the turn should be waiting');
      const modelCalls = ScriptedModel.calls.length;
      t.chaos.set(ChaosFlag.TOOL_DOWN, false);
      assert.match((await reply).text_response, /John/);
      // The turn resumed after the tool: the model calls before it were not made again
      assert.strictEqual(ScriptedModel.calls.length, modelCalls + 2);
    });
  });

  it('waits out a model outage, and the turn resumes where it stopped', async () => {
    const t = await createTestWorker(env);
    await t.runUntil(async () => {
      const { handle, send } = await startChat(t, 'llm-down');
      await send('Who are my beneficiaries?');
      t.chaos.set(ChaosFlag.LLM_DOWN, true);
      const reply = send('Who are my beneficiaries again?');
      await waitFor(async () => (t.chaos.events.some((e) => e.flag === ChaosFlag.LLM_DOWN) ? true : undefined));
      await sleep(1500);
      assert.strictEqual((await handle.query<unknown[]>('get_chat_history')).length, 1, 'the turn should be waiting');
      t.chaos.set(ChaosFlag.LLM_DOWN, false);
      assert.match((await reply).text_response, /John/);
      assert.match(t.chaos.events.find((e) => e.flag === ChaosFlag.LLM_DOWN)?.source ?? '', /invokeModel/);
    });
  });

  it('delays the retry of a rate-limited model call by 15 seconds', async () => {
    const t = await createTestWorker(env);
    await t.runUntil(async () => {
      const { handle } = await startChat(t, 'llm-429');
      t.chaos.set(ChaosFlag.LLM_RATE_LIMITED, true);
      // A plain signal: the reply never comes, so nothing should be left waiting for it
      await handle.signal(PROCESS_USER_MESSAGE_SIGNAL, { user_input: 'Who are my beneficiaries?' });
      const pending = await waitFor(async () => {
        const d = await handle.describe();
        return d.raw.pendingActivities?.find((a) => a.lastFailure) ?? undefined;
      });
      const info = pending.lastFailure!.applicationFailureInfo!;
      assert.strictEqual(info.type, 'ModelRateLimited');
      assert.strictEqual(Number(info.nextRetryDelay?.seconds), 15);
      // The server scheduled the next attempt 15 seconds after the failure, not after the 1s backoff
      const failedAt = Number(pending.lastAttemptCompleteTime!.seconds);
      const nextAt = Number(pending.nextAttemptScheduleTime!.seconds);
      assert.ok(nextAt - failedAt >= 14, `next attempt ${nextAt - failedAt}s after the failure`);
      await handle.terminate('test done');
    });
  });

  it("reads the model flags for the chat's own browser session, inside the model activity", async () => {
    // The worker's real flag source over in-memory Redis: the session is found from the activity's workflow ID
    const redis = new FakeChaosRedis();
    const manager = new ChaosManager({ redis: redis as unknown as Redis });
    const events: string[] = [];
    const t = await createTestWorker(env, {
      chaos: {
        isEnabled: (flag) => manager.isEnabled(flag),
        recordEvent: async (e) => {
          events.push(`${e.flag} ${e.source} ${e.workflow_id}`);
        },
      },
    });
    const prefix = 'strands-ts-temporal-agent-';
    const [mine, other] = [newSessionId(), newSessionId()];
    redis.turnOn(other, ChaosFlag.LLM_DOWN);
    await t.runUntil(async () => {
      // Another browser's flag leaves this chat alone
      const { handle, send } = await startChat(t, '', newChatWorkflowId(prefix, mine));
      assert.match((await send('Who are my beneficiaries?')).text_response, /John/);
      assert.deepStrictEqual(events, []);
      // This browser's flag stops its model calls
      redis.turnOn(mine, ChaosFlag.LLM_DOWN);
      const reply = send('Who are my beneficiaries again?');
      await waitFor(async () => (events.length > 0 ? true : undefined));
      assert.match(events[0], new RegExp(`^llm_down \\S*invokeModel\\S* ${handle.workflowId}$`));
      redis.hashes.delete(flagsKey(mine));
      assert.match((await reply).text_response, /John/);
    });
  });

  // -------------------------------------------------------------------------
  // The open-account workflow
  // -------------------------------------------------------------------------

  async function runOpening(t: TestWorker, input: Partial<OpenInvestmentAccountInput>) {
    const handle = await env.client.workflow.start(OpenInvestmentAccountWorkflow, {
      taskQueue: t.taskQueue,
      workflowId: `opening-${Date.now()}-${Math.random()}`,
      args: [{ client_id: '123', account_name: 'Vacation', initial_amount: 1000, promo_code: null, ...input }],
    });
    await handle.signal(verifyKycSignal);
    await handle.signal(complianceApprovedSignal);
    return handle;
  }

  it('opens the account: creates the record, debits the linked account, registers it', async () => {
    const t = await createTestWorker(env);
    await t.runUntil(async () => {
      const handle = await runOpening(t, { initial_amount: 13_000 });
      const result = await handle.result();
      assert.deepStrictEqual(result, { account_created: true, message: 'investment account created' });
      assert.strictEqual(await handle.query(getCurrentStateQuery), STATE_COMPLETE);
      assert.ok((await t.store.listInvestments('123')).some((a) => a.name === 'Vacation' && a.balance === 13_000));
      assert.strictEqual((await t.store.getFundingAccount('123')).balance, 237_000);
      assert.deepStrictEqual(await scheduledActivities(handle), [
        'get_client',
        'open_investment',
        'debit_linked_account',
        'register_account',
      ]);
    });
  });

  it('rolls back in reverse order when the custodian rejects the account', async () => {
    const t = await createTestWorker(env);
    t.chaos.set(ChaosFlag.CUSTODIAN_REJECTS, true);
    await t.runUntil(async () => {
      const handle = await runOpening(t, {});
      const result = await handle.result();
      assert.strictEqual(result.account_created, false);
      assert.match(result.message, /custodian rejected/);
      assert.strictEqual(
        await handle.query(getCurrentStateQuery),
        'Rolled back. The account was not opened: The custodian rejected the account registration.',
      );
      assert.deepStrictEqual((await scheduledActivities(handle)).slice(-3), [
        'register_account',
        'credit_linked_account',
        'remove_investment',
      ]);
      assert.ok(!(await t.store.listInvestments('123')).some((a) => a.name === 'Vacation'));
      assert.strictEqual((await t.store.getFundingAccount('123')).balance, 250_000);
    });
  });

  it('rolls back when the linked account has insufficient funds ($300,000 for client 123)', async () => {
    const t = await createTestWorker(env);
    await t.runUntil(async () => {
      const handle = await runOpening(t, { initial_amount: 300_000 });
      const result = await handle.result();
      assert.strictEqual(result.account_created, false);
      assert.match(result.message, /not enough to transfer \$300,000\.00/);
      assert.deepStrictEqual((await scheduledActivities(handle)).slice(-2), [
        'debit_linked_account',
        'remove_investment',
      ]);
      assert.ok(!(await t.store.listInvestments('123')).some((a) => a.name === 'Vacation'));
      assert.strictEqual((await t.store.getFundingAccount('123')).balance, 250_000);
    });
  });

  it('reports every saga state to the parent chat, in order', async () => {
    const t = await createTestWorker(env);
    t.chaos.set(ChaosFlag.CUSTODIAN_REJECTS, true);
    await t.runUntil(async () => {
      const { handle, send } = await startChat(t, 'saga-states');
      await send('Open Vacation with $13,000');
      await send('Yes');
      const opening = `OpenAccount-${handle.workflowId}-123-Vacation-1`;
      await env.client.workflow.getHandle(opening).signal(complianceApprovedSignal);
      await waitFor(async () => ((await openingStates(handle))[opening]?.startsWith('Rolled back') ? true : undefined));
      const statuses = await waitFor(async () => {
        const events = await t.events.getEventsFromIndex(handle.workflowId, 0);
        const s = events.filter((e) => e.type === 'status_update').map((e) => (e.content as { status: string }).status);
        return s.some((x) => x.includes('Rolled back.')) ? s : undefined;
      });
      const prefix = 'New Vacation account status changed: ';
      assert.deepStrictEqual(
        statuses.map((s) => s.replace(prefix, '')),
        [
          'Waiting KYC',
          'Waiting Compliance Review',
          'Compliance review has been approved. Creating Investment Account',
          'Creating the account record.',
          'Transferring $13,000.00 from the linked bank account.',
          'Registering the account with the custodian.',
          'Failed: The custodian rejected the account registration. Rolling back.',
          'Rolling back: refunding $13,000.00 to the linked bank account.',
          'Rolling back: removing the account record.',
          'Rolled back. The account was not opened: The custodian rejected the account registration.',
        ],
      );
    });
  });

  it('pauses on the bug in workflow code: the workflow task fails, the workflow stays Running', async () => {
    const t = await createTestWorker(env);
    await t.runUntil(async () => {
      const handle = await runOpening(t, { promo_code: 'WELCOME-BONUS' });
      const failure = await waitFor(async () => {
        const { events } = await handle.fetchHistory();
        return (events ?? []).find((e) => e.workflowTaskFailedEventAttributes)?.workflowTaskFailedEventAttributes;
      });
      assert.match(failure?.failure?.message ?? '', /rate/);
      const d = await handle.describe();
      assert.strictEqual(d.status.name, 'RUNNING');
      // The compliance approval is kept: the workflow stopped right after it, before the saga
      const { events } = await handle.fetchHistory();
      const signals = (events ?? []).map((e) => e.workflowExecutionSignaledEventAttributes?.signalName).filter(Boolean);
      assert.ok(signals.includes('compliance_approved'));
      assert.ok(!(await scheduledActivities(handle)).includes('open_investment'));
      await handle.terminate('test done');
    });
  });
});
