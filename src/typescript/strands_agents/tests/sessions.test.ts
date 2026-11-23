// The Strands data store (strands_lib/data-store.ts) with DEMO_DATA_STORE=redis: one copy of the sample data
// per browser session, under the same keys as every other framework (common/data-store.ts). Redis is
// replaced by an in-memory fake.
import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { MockActivityEnvironment } from '@temporalio/testing';
import { DataStore } from '../strands_lib/data-store';
import { setDataStoreRedis, type DataStoreRedis } from '../../common/data-store';
import { newChatWorkflowId, newSessionId } from '../../common/session-scope';
import { freshDataDir } from './helpers';

const PREFIX = 'strands-ts-temporal-agent-';

class FakeRedis {
  readonly values = new Map<string, string>();
  readonly expiry = new Map<string, number>();
  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }
  async set(key: string, value: string, mode?: string, seconds?: number): Promise<'OK'> {
    this.values.set(key, value);
    if (mode === 'EX' && seconds !== undefined) this.expiry.set(key, seconds);
    return 'OK';
  }
}

function inActivityOf<T>(workflowId: string, fn: () => Promise<T>): Promise<T> {
  return new MockActivityEnvironment({ workflowExecution: { workflowId, runId: 'run-1' } }).run(fn);
}

describe('data store per browser session', () => {
  let fake: FakeRedis;
  let dir: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.DEMO_DATA_STORE;
    fake = new FakeRedis();
    setDataStoreRedis(fake as unknown as DataStoreRedis);
    dir = freshDataDir();
  });

  afterEach(() => {
    setDataStoreRedis(undefined);
    if (savedEnv === undefined) delete process.env.DEMO_DATA_STORE;
    else process.env.DEMO_DATA_STORE = savedEnv;
  });

  it('writes the files by default, and nothing to Redis', async () => {
    delete process.env.DEMO_DATA_STORE;
    const store = new DataStore(dir);
    const before = (await store.listBeneficiaries('123')).length;
    await store.addBeneficiary('123', 'Jane', 'Doe', 'daughter');
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'beneficiaries.json'), 'utf-8'));
    assert.strictEqual(onDisk['123'].length, before + 1);
    assert.strictEqual(fake.values.size, 0);
  });

  it('gives each session its own copy under data:<session>:<file>, and leaves the files alone', async () => {
    process.env.DEMO_DATA_STORE = 'redis';
    const files = Object.fromEntries(fs.readdirSync(dir).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf-8')]));
    const store = new DataStore(dir);
    const [alice, bob] = [newSessionId(), newSessionId()];
    const aliceChat = newChatWorkflowId(PREFIX, alice);
    const bobChat = newChatWorkflowId(PREFIX, bob);
    const before = (await store.listInvestments('123')).length;
    const balance = (await store.getFundingAccount('123')).balance;

    await inActivityOf(`OpenAccount-${aliceChat}-123-Vacation-1`, async () => {
      await store.addInvestment({ client_id: '123', name: 'Vacation', balance: 500 });
      await store.debit('123', 500, 't-1');
      await store.addBeneficiary('123', 'Jane', 'Doe', 'daughter');
      await store.updateClient('123', { phone: '555-0100' });
    });

    assert.strictEqual((await inActivityOf(aliceChat, () => store.listInvestments('123'))).length, before + 1);
    assert.strictEqual((await inActivityOf(aliceChat, () => store.getFundingAccount('123'))).balance, balance - 500);
    assert.strictEqual((await inActivityOf(aliceChat, () => store.getClient('123')))?.phone, '555-0100');
    assert.strictEqual((await inActivityOf(bobChat, () => store.listInvestments('123'))).length, before);
    assert.strictEqual((await inActivityOf(bobChat, () => store.getFundingAccount('123'))).balance, balance);

    assert.deepStrictEqual(
      [...fake.values.keys()].sort(),
      ['beneficiaries', 'clients', 'funding_accounts', 'investments'].map((n) => `data:${alice}:${n}`),
    );
    for (const key of fake.values.keys()) assert.strictEqual(fake.expiry.get(key), 24 * 60 * 60);
    for (const [f, text] of Object.entries(files))
      assert.strictEqual(fs.readFileSync(path.join(dir, f), 'utf-8'), text);
  });
});
