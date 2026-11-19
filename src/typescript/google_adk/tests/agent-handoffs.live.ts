/**
 * Live: agent handoffs. "Who are my beneficiaries?", "123", then "What investments do I have?".
 * Run with: source ../../../scripts/setgeminikey.sh && LIVE_TEST_RUNS=3 npm run test:live
 */
import assert from 'assert';
import { after, before, describe, it } from 'mocha';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { LIVE_TEST_RUNS, liveWorker, printTranscript, requireApiKey, startLiveChat } from './live-helpers';

describe('live: agent handoffs', function () {
  this.timeout(600_000);
  let env: TestWorkflowEnvironment;

  before(async () => {
    requireApiKey();
    env = await TestWorkflowEnvironment.createLocal();
  });
  after(async () => {
    await env?.teardown();
  });

  for (let run = 1; run <= LIVE_TEST_RUNS; run++) {
    it(`run ${run}/${LIVE_TEST_RUNS}: hands off in the same turn and lists the investments without asking again`, async () => {
      const t = await liveWorker(env);
      await t.worker.runUntil(async () => {
        const chat = await startLiveChat(env, t, 'live-handoffs');
        try {
          await chat.send('Who are my beneficiaries?');
          const listed = await chat.send('123');
          assert.match(listed.text_response, /John/);
          assert.match(listed.text_response, /Jane/);

          const last = await chat.send('What investments do I have?');
          assert.match(last.agent_trace, /Handed off from Beneficiary_Agent to Supervisor_Agent/);
          assert.match(last.agent_trace, /Handed off from Supervisor_Agent to Investment_Agent/);
          for (const account of ['Checking', 'Savings', '401K']) assert.match(last.text_response, new RegExp(account));
          assert.doesNotMatch(last.text_response, /client id/i, 'asked for the client ID again');
          for (const line of chat.transcript.filter((l) => l.startsWith('Agent:'))) {
            assert.doesNotMatch(line, /transfer/i, `an agent mentioned a transfer: ${line}`);
          }
        } finally {
          printTranscript(`agent handoffs, run ${run}`, chat);
        }
      });
    });
  }
});
