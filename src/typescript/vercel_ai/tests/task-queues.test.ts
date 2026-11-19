// The open-account workflow's task queue (common/task-queues.ts), which every TypeScript framework uses.
import assert from 'assert';
import { openAccountTaskQueue } from '../../common/task-queues';
import { workflowsModule } from '../durable/worker-workflows';

describe('open-account task queue', () => {
  it('is the chat queue without a value', () => {
    for (const value of [undefined, '', '  ']) {
      assert.strictEqual(openAccountTaskQueue('VAI-Supervisor', value), 'VAI-Supervisor');
    }
  });

  it("is the framework's own <task queue>-open-account with java", () => {
    for (const value of ['java', 'Java', ' JAVA ']) {
      assert.strictEqual(openAccountTaskQueue('VAI-Supervisor', value), 'VAI-Supervisor-open-account');
    }
    assert.strictEqual(openAccountTaskQueue('ADK-TS-Supervisor', 'java'), 'ADK-TS-Supervisor-open-account');
  });

  it('is any other value as given', () => {
    assert.strictEqual(openAccountTaskQueue('VAI-Supervisor', 'My-Queue'), 'My-Queue');
  });

  it('leaves the workflow out of the worker when java runs it', () => {
    const queue = 'VAI-Supervisor';
    assert.strictEqual(workflowsModule(queue, openAccountTaskQueue(queue, 'java')), './workflows/supervisor-only');
    assert.strictEqual(workflowsModule(queue, openAccountTaskQueue(queue, undefined)), './workflows/index');
  });
});
