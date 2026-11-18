// The API requires the AI framework: a missing or unknown one stops it with every valid option.
import assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { FRAMEWORKS, selectedFramework } from '../frameworks';

const EVERY_FRAMEWORK = ['vercel_ai'];

describe('AI framework', () => {
  it('knows every framework', () => {
    assert.deepStrictEqual(Object.keys(FRAMEWORKS), EVERY_FRAMEWORK);
  });

  for (const name of ['', 'openai_agents', 'toString']) {
    it(`refuses ${JSON.stringify(name)} and lists every framework`, () => {
      assert.throws(
        () => selectedFramework({ AI_FRAMEWORK: name }),
        (err: Error) => EVERY_FRAMEWORK.every((f) => err.message.includes(f)),
      );
    });

    it(`stops the start scripts for ${JSON.stringify(name)}, listing every framework`, () => {
      const tsNode = path.resolve(__dirname, '../../node_modules/.bin/ts-node');
      try {
        execFileSync(tsNode, ['frameworks.ts', 'startlocalapi.sh', name], {
          cwd: path.resolve(__dirname, '..'),
          stdio: 'pipe',
        });
        assert.fail('the check passed');
      } catch (err: any) {
        assert.strictEqual(err.status, 2);
        const stderr = String(err.stderr);
        assert.ok(
          EVERY_FRAMEWORK.every((f) => stderr.includes(f)),
          stderr,
        );
      }
    });
  }

  it('gives the framework its task queue and workflow ID prefix', () => {
    const framework = selectedFramework({ AI_FRAMEWORK: 'vercel_ai' });
    assert.strictEqual(framework.taskQueue, 'VAI-Supervisor');
    assert.strictEqual(framework.workflowIdPrefix, 'vai-temporal-agent-');
  });

  it('lets CHAT_WORKFLOW_ID_PREFIX override the prefix', () => {
    const framework = selectedFramework({ AI_FRAMEWORK: 'vercel_ai', CHAT_WORKFLOW_ID_PREFIX: 'mine-' });
    assert.strictEqual(framework.workflowIdPrefix, 'mine-');
  });

  it('matches the Python API for the frameworks they share', () => {
    const python = path.resolve(__dirname, '../../../python/api/frameworks.py');
    const source = fs.readFileSync(python, 'utf8');
    for (const f of Object.values(FRAMEWORKS)) {
      assert.ok(
        source.includes(`"${f.name}"`) &&
          source.includes(`"${f.taskQueue}"`) &&
          source.includes(`"${f.workflowIdPrefix}"`),
        `${f.name} differs in the Python API's frameworks.py`,
      );
    }
  });
});
