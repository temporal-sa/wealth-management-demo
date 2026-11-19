// Browser sessions (common/session-scope.ts) and what they scope: the sample data (common/data-store.ts,
// with DEMO_DATA_STORE=redis) and the chaos flags (common/chaos-manager.ts). The same rules as the
// Python and Go frameworks, which share the Redis keys. Redis is replaced by an in-memory fake.
import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type Redis from 'ioredis';
import { MockActivityEnvironment } from '@temporalio/testing';
import { BeneficiariesManager } from '../../common/beneficiaries-manager';
import { ChaosFlag, ChaosManager } from '../../common/chaos-manager';
import { setDataStoreRedis, useRedis, type DataStoreRedis } from '../../common/data-store';
import { FundingManager } from '../../common/funding-manager';
import { InvestmentManager } from '../../common/investment-manager';
import {
  DEFAULT_SESSION,
  SESSION_TTL_SECONDS,
  chatWorkflowPrefix,
  currentSession,
  isSessionId,
  newChatWorkflowId,
  newSessionId,
  ownsWorkflow,
  sessionFromWorkflowId,
} from '../../common/session-scope';

const PREFIX = 'vercel-ai-temporal-agent-';
const DAY = 24 * 60 * 60;

/** The Redis calls the data store and the chaos manager make, with expiries. */
class FakeRedis {
  readonly values = new Map<string, string>();
  readonly hashes = new Map<string, Map<string, string>>();
  readonly lists = new Map<string, string[]>();
  readonly expiry = new Map<string, number>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }
  async set(key: string, value: string, mode?: string, seconds?: number): Promise<'OK'> {
    this.values.set(key, value);
    if (mode === 'EX' && seconds !== undefined) this.expiry.set(key, seconds);
    else this.expiry.delete(key);
    return 'OK';
  }
  async hget(key: string, field: string): Promise<string | null> {
    return this.hashes.get(key)?.get(field) ?? null;
  }
  async hset(key: string, field: string, value: string): Promise<number> {
    if (!this.hashes.has(key)) this.hashes.set(key, new Map());
    this.hashes.get(key)!.set(field, value);
    return 1;
  }
  async hdel(key: string, field: string): Promise<number> {
    return this.hashes.get(key)?.delete(field) ? 1 : 0;
  }
  async hgetall(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.hashes.get(key) ?? []);
  }
  async expire(key: string, seconds: number): Promise<number> {
    this.expiry.set(key, seconds);
    return 1;
  }
  async lpush(key: string, value: string): Promise<number> {
    const list = [value, ...(this.lists.get(key) ?? [])];
    this.lists.set(key, list);
    return list.length;
  }
  async ltrim(key: string, start: number, end: number): Promise<'OK'> {
    this.lists.set(key, (this.lists.get(key) ?? []).slice(start, end + 1));
    return 'OK';
  }
  async lrange(key: string, start: number, end: number): Promise<string[]> {
    return (this.lists.get(key) ?? []).slice(start, end + 1);
  }
  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const key of keys) {
      for (const store of [this.values, this.hashes, this.lists]) if (store.delete(key)) n++;
    }
    return n;
  }
}

/** Runs fn as an activity of the workflow with this ID. */
function inActivityOf<T>(workflowId: string, fn: () => Promise<T>): Promise<T> {
  const env = new MockActivityEnvironment({ workflowExecution: { workflowId, runId: 'run-1' } });
  return env.run(fn);
}

describe('browser sessions', () => {
  describe('workflow IDs', () => {
    it('gives chat workflow IDs the session, and only the session owns them', () => {
      const session = newSessionId();
      assert.ok(isSessionId(session));
      assert.ok(!isSessionId('default') && !isSessionId(session.toUpperCase()) && !isSessionId(undefined));
      const chat = newChatWorkflowId(PREFIX, session);
      assert.match(chat, new RegExp(`^${PREFIX}session-${session}-chat-[0-9a-f]{16}$`));
      assert.ok(ownsWorkflow(PREFIX, session, chat));
      assert.ok(!ownsWorkflow(PREFIX, newSessionId(), chat));
      assert.ok(!ownsWorkflow(PREFIX, session, chatWorkflowPrefix(PREFIX, session)));
      assert.ok(!ownsWorkflow(PREFIX, session, 'vercel-ai-temporal-agent-k3j9x2m1q8'));
    });

    it("finds the session in a chat's or an account opening's workflow ID", () => {
      const session = newSessionId();
      const chat = newChatWorkflowId(PREFIX, session);
      assert.strictEqual(sessionFromWorkflowId(chat), session);
      assert.strictEqual(sessionFromWorkflowId(`OpenAccount-${chat}-123-Vacation account-1`), session);
      for (const other of ['vercel-ai-temporal-agent-k3j9x2m1q8', 'testing-open-account-1', '', undefined, null]) {
        assert.strictEqual(sessionFromWorkflowId(other), DEFAULT_SESSION);
      }
    });

    it("finds the running activity's session from its workflow ID, and uses the default outside one", async () => {
      const session = newSessionId();
      const chat = newChatWorkflowId(PREFIX, session);
      assert.strictEqual(
        await inActivityOf(`OpenAccount-${chat}-123-Vacation-1`, async () => currentSession()),
        session,
      );
      assert.strictEqual(await inActivityOf('testing-open-account-1', async () => currentSession()), DEFAULT_SESSION);
      assert.strictEqual(currentSession(), DEFAULT_SESSION);
      assert.strictEqual(SESSION_TTL_SECONDS, DAY);
    });
  });

  describe('chaos flags', () => {
    it('keeps flags and failure logs per session, expiring a day after the last change', async () => {
      const fake = new FakeRedis();
      const redis = fake as unknown as Redis;
      const [aliceId, bobId] = [newSessionId(), newSessionId()];
      const alice = new ChaosManager({ sessionId: aliceId, redis });
      const bob = new ChaosManager({ sessionId: bobId, redis });

      await alice.setEnabled(ChaosFlag.TOOL_DOWN, true);
      await alice.recordEvent({ flag: ChaosFlag.TOOL_DOWN, source: 'get_client', attempt: 1, workflow_id: 'wf-1' });

      assert.ok(await alice.isEnabled(ChaosFlag.TOOL_DOWN));
      assert.ok(!(await bob.isEnabled(ChaosFlag.TOOL_DOWN)));
      const enabled = async (m: ChaosManager) =>
        (await m.getFlags()).find((f) => f.flag === ChaosFlag.TOOL_DOWN)!.enabled;
      assert.ok((await enabled(alice)) && !(await enabled(bob)));
      assert.strictEqual((await alice.getEvents()).length, 1);
      assert.deepStrictEqual(await bob.getEvents(), []);
      assert.strictEqual(fake.hashes.get(`chaos:${aliceId}:flags`)?.get('tool_down'), '1');
      assert.strictEqual(fake.expiry.get(`chaos:${aliceId}:flags`), DAY);
      assert.strictEqual(fake.expiry.get(`chaos:${aliceId}:events`), DAY);
      assert.ok(!fake.hashes.has('chaos:flags') && !fake.lists.has('chaos:events'));

      await alice.clearEvents();
      assert.deepStrictEqual(await alice.getEvents(), []);
      assert.ok(await alice.isEnabled(ChaosFlag.TOOL_DOWN));
      await alice.setEnabled(ChaosFlag.TOOL_DOWN, false);
      assert.ok(!(await alice.isEnabled(ChaosFlag.TOOL_DOWN)));
    });

    it("uses the running activity's session, and the default session outside an activity", async () => {
      const fake = new FakeRedis();
      const manager = new ChaosManager({ redis: fake as unknown as Redis });
      const session = newSessionId();
      const chat = newChatWorkflowId(PREFIX, session);

      await inActivityOf(chat, () => manager.setEnabled(ChaosFlag.SLOW_SAGA, true));
      assert.ok(await inActivityOf(`OpenAccount-${chat}-123-Vacation-1`, () => manager.isEnabled(ChaosFlag.SLOW_SAGA)));
      assert.ok(!(await manager.isEnabled(ChaosFlag.SLOW_SAGA)));

      await manager.setEnabled(ChaosFlag.LLM_DOWN, true);
      assert.deepStrictEqual([...fake.hashes.keys()].sort(), [`chaos:${session}:flags`, 'chaos:default:flags'].sort());
    });
  });

  describe('data store', () => {
    let fake: FakeRedis;
    let dir: string;
    let savedEnv: string | undefined;

    const file = (name: string) => path.join(dir, `${name}.json`);
    const readFile = (name: string) => JSON.parse(fs.readFileSync(file(name), 'utf-8'));

    beforeEach(() => {
      savedEnv = process.env.DEMO_DATA_STORE;
      fake = new FakeRedis();
      setDataStoreRedis(fake as unknown as DataStoreRedis);
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-sessions-'));
      const files: Record<string, unknown> = {
        beneficiaries: {
          '123': [{ beneficiary_id: 'b-1', first_name: 'John', last_name: 'Doe', relationship: 'son' }],
        },
        investments: { '123': [{ investment_id: 'i-1', name: 'Checking', balance: 1000.0 }] },
        funding_accounts: { accounts: { '123': { name: 'Checking', balance: 10000.0 } }, transfers: {} },
      };
      for (const [name, content] of Object.entries(files)) fs.writeFileSync(file(name), JSON.stringify(content));
    });

    afterEach(() => {
      setDataStoreRedis(undefined);
      if (savedEnv === undefined) delete process.env.DEMO_DATA_STORE;
      else process.env.DEMO_DATA_STORE = savedEnv;
    });

    it('reads DEMO_DATA_STORE: file by default, redis in any case', () => {
      assert.ok(!useRedis({}));
      assert.ok(!useRedis({ DEMO_DATA_STORE: 'file' }));
      assert.ok(useRedis({ DEMO_DATA_STORE: ' Redis ' }));
    });

    it('writes the files by default, and nothing to Redis', async () => {
      delete process.env.DEMO_DATA_STORE;
      await new BeneficiariesManager(file('beneficiaries')).addBeneficiary('123', 'Jane', 'Doe', 'daughter');
      assert.deepStrictEqual(
        readFile('beneficiaries')['123'].map((b: { first_name: string }) => b.first_name),
        ['John', 'Jane'],
      );
      assert.strictEqual(fake.values.size, 0);
    });

    it('gives each session its own copy in Redis, and leaves the file alone', async () => {
      process.env.DEMO_DATA_STORE = 'redis';
      const [alice, bob] = [newSessionId(), newSessionId()];
      // Created once, like the activities' module-level managers: the session is looked up per call
      const manager = new BeneficiariesManager(file('beneficiaries'));
      const names = async (workflowId: string) =>
        (await inActivityOf(workflowId, () => manager.listBeneficiaries('123'))).map((b) => b.first_name);

      await inActivityOf(newChatWorkflowId(PREFIX, alice), () =>
        manager.addBeneficiary('123', 'Jane', 'Doe', 'daughter'),
      );
      assert.deepStrictEqual(await names(`OpenAccount-${newChatWorkflowId(PREFIX, alice)}-123-x-1`), ['John', 'Jane']);
      assert.deepStrictEqual(await names(newChatWorkflowId(PREFIX, bob)), ['John']);

      assert.deepStrictEqual(
        readFile('beneficiaries')['123'].map((b: { first_name: string }) => b.first_name),
        ['John'],
      );
      assert.deepStrictEqual([...fake.values.keys()], [`data:${alice}:beneficiaries`]);
      assert.strictEqual(fake.expiry.get(`data:${alice}:beneficiaries`), DAY);
    });

    it('covers investments and funding, under the file names without .json', async () => {
      process.env.DEMO_DATA_STORE = 'redis';
      const session = newSessionId();
      const chat = newChatWorkflowId(PREFIX, session);
      const funding = new FundingManager(file('funding_accounts'));
      const investments = new InvestmentManager(file('investments'));

      await inActivityOf(chat, () => funding.debit('123', 500, 't-1'));
      await inActivityOf(chat, () => investments.addInvestmentAccount('123', 'Vacation', 500));

      assert.deepStrictEqual([...fake.values.keys()].sort(), [
        `data:${session}:funding_accounts`,
        `data:${session}:investments`,
      ]);
      assert.strictEqual((await inActivityOf(chat, () => funding.getAccount('123'))).balance, 9500);
      assert.deepStrictEqual(
        (await inActivityOf(chat, () => investments.listInvestmentAccounts('123'))).map((a) => a.name),
        ['Checking', 'Vacation'],
      );
      // The default session (outside an activity) still sees the file, which is unchanged
      assert.strictEqual((await funding.getAccount('123')).balance, 10000);
      assert.strictEqual(readFile('funding_accounts').accounts['123'].balance, 10000);
      assert.strictEqual(readFile('investments')['123'].length, 1);
    });
  });
});
