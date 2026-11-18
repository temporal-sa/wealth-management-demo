/**
 * KYC guard: approve_kyc refuses until this opening's details were shown to the customer in an
 * earlier turn.
 */
import assert from 'assert';
import { after, before, describe, it } from 'mocha';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { OPEN_ACCOUNT_AGENT_NAME } from '../../common/agent-constants';
import { STATE_WAITING_COMPLIANCE, STATE_WAITING_KYC } from '../shared';
import {
  detailsDisplayed,
  kycApprovalRefusal,
  KYC_NOT_APPROVED,
  WealthManagementWorkflow,
} from '../workflows/wealth-management';
import { chatSender, createTestWorker, openingStates, ScriptedLlm, waitFor } from './helpers';
import { handoffScript, openAccountScript } from './scripts';

describe('KYC guard', function () {
  this.timeout(90_000);
  let env: TestWorkflowEnvironment;

  before(async () => {
    env = await TestWorkflowEnvironment.createLocal();
  });
  after(async () => {
    await env?.teardown();
  });

  it('refuses unless the details were shown in an earlier turn', () => {
    assert.strictEqual(kycApprovalRefusal(undefined, 3), KYC_NOT_APPROVED);
    assert.strictEqual(kycApprovalRefusal(3, 3), KYC_NOT_APPROVED);
    assert.strictEqual(kycApprovalRefusal(2, 3), undefined);
  });

  it('counts the details as shown only when the reply contains them', () => {
    const don = {
      first_name: 'Don',
      last_name: 'Doe',
      address: '123 Main Street',
      phone: '999-555-1212',
      email: 'jd@someplace.com',
      marital_status: 'married',
    };
    assert.ok(detailsDisplayed(don, 'Don Doe, 123 Main Street, jd@someplace.com. Correct?'));
    assert.ok(!detailsDisplayed(don, 'Please confirm your details.'));
    assert.ok(!detailsDisplayed(null, 'Don Doe jd@someplace.com'));
  });

  it('does not approve KYC in the turn the details were fetched, and does once the customer confirms', async () => {
    // The Open Account Agent tries to approve KYC right after fetching the details
    ScriptedLlm.script = (req) =>
      req.agent === OPEN_ACCOUNT_AGENT_NAME ? openAccountScript(req, true) : handoffScript(req);
    const t = await createTestWorker(env);
    await t.worker.runUntil(async () => {
      const chatId = `kyc-${Date.now()}`;
      const handle = await env.client.workflow.start(WealthManagementWorkflow, {
        taskQueue: t.taskQueue,
        workflowId: chatId,
      });
      const send = chatSender(handle);
      await send('What investments do I have?');
      await send('123');
      const opening = `OpenAccount-${chatId}-123-Vacation-1`;

      const reply = await send('Open Vacation with $500');
      assert.match(reply.json_response, /KYC was not approved/);
      await waitFor(async () => ((await openingStates(handle))[opening] === STATE_WAITING_KYC ? true : undefined));
      // Give a wrongly sent verify_kyc time to land, then check it didn't
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
});
