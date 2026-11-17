/**
 * Live: repeat opening. The handoff conversation, then "Open Vacation with $13,000", "Yes", and
 * "Open Vacation with $13,000" again: both replies show the KYC details, and ...-Vacation-1 and
 * ...-Vacation-2 were started.
 * Run with: source setgeminikey.sh && LIVE_TEST_RUNS=3 npm run test:live
 */
import assert from 'assert';
import { after, before, describe, it } from 'mocha';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { openingStates } from './helpers';
import { LIVE_TEST_RUNS, liveWorker, printTranscript, requireApiKey, startLiveChat } from './live-helpers';

describe('live: repeat opening', function () {
  this.timeout(900_000);
  let env: TestWorkflowEnvironment;

  before(async () => {
    requireApiKey();
    env = await TestWorkflowEnvironment.createLocal();
  });
  after(async () => {
    await env?.teardown();
  });

  for (let run = 1; run <= LIVE_TEST_RUNS; run++) {
    it(`run ${run}/${LIVE_TEST_RUNS}: every request starts a new opening with its own KYC`, async () => {
      const t = await liveWorker(env);
      await t.worker.runUntil(async () => {
        const chat = await startLiveChat(env, t, 'live-repeat');
        try {
          await chat.send('Who are my beneficiaries?');
          await chat.send('123');
          await chat.send('What investments do I have?');

          const first = await chat.send('Open Vacation with $13,000');
          assert.match(first.text_response, /Don/);
          assert.match(first.text_response, /123 Main Street/);
          await chat.send('Yes');
          const second = await chat.send('Open Vacation with $13,000');
          assert.match(second.text_response, /Don/);
          assert.match(second.text_response, /123 Main Street/);

          const ids = Object.keys(await openingStates(chat.handle));
          const prefix = `OpenAccount-${chat.handle.workflowId}-123-Vacation-`;
          assert.ok(ids.includes(`${prefix}1`), `started ${ids.join(', ')}`);
          assert.ok(ids.includes(`${prefix}2`), `started ${ids.join(', ')}`);
        } finally {
          printTranscript(`repeat opening, run ${run}`, chat);
        }
      });
    });
  }
});
