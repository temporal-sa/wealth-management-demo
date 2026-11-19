// The claim check writes the same payloads as the Python frameworks and the Java worker, so each can
// read the others' (the Java worker only decodes payloads whose encoding is "claim-checked").
import assert from 'assert';
import type Redis from 'ioredis';
import { ClaimCheckCodec, claimCheckTtlSeconds } from '../../common/claim-check-codec';

// Seconds each key expires in, as set by SET key value EX seconds
const expiries = new Map<string, number | undefined>();

function fakeRedis(): Redis {
  const store = new Map<string, Buffer>();
  return {
    set: async (key: string, value: Buffer, mode?: string, seconds?: number) => {
      store.set(key, Buffer.from(value));
      expiries.set(key, mode === 'EX' ? seconds : undefined);
    },
    getBuffer: async (key: string) => store.get(key) ?? null,
  } as unknown as Redis;
}

const payload = { metadata: { encoding: Buffer.from('json/plain') }, data: Buffer.from('{"client_id":"123"}') };

describe('claim check codec', () => {
  it('writes the encoding the Python frameworks and the Java worker use', async () => {
    const [encoded] = await new ClaimCheckCodec(fakeRedis()).encode([payload]);
    assert.strictEqual(Buffer.from(encoded.metadata!.encoding!).toString(), 'claim-checked');
    assert.strictEqual(Buffer.from(encoded.metadata!['temporal.io/claim-check-codec']!).toString(), 'v1');
  });

  it('gets the payload back from Redis', async () => {
    const codec = new ClaimCheckCodec(fakeRedis());
    const [decoded] = await codec.decode(await codec.encode([payload]));
    assert.deepStrictEqual(Buffer.from(decoded.data!), payload.data);
    assert.strictEqual(Buffer.from(decoded.metadata!.encoding!).toString(), 'json/plain');
  });

  it('leaves other payloads alone', async () => {
    const [decoded] = await new ClaimCheckCodec(fakeRedis()).decode([payload]);
    assert.strictEqual(decoded, payload);
  });

  it('stores payloads that expire after seven days by default', async () => {
    const [encoded] = await new ClaimCheckCodec(fakeRedis(), claimCheckTtlSeconds({})).encode([payload]);
    assert.strictEqual(expiries.get(Buffer.from(encoded.data!).toString()), 7 * 24 * 60 * 60);
  });

  it('reads the expiry from CLAIM_CHECK_TTL_SECONDS, where 0 keeps payloads forever', async () => {
    assert.strictEqual(claimCheckTtlSeconds({ CLAIM_CHECK_TTL_SECONDS: '3600' }), 3600);
    assert.strictEqual(claimCheckTtlSeconds({ CLAIM_CHECK_TTL_SECONDS: '0' }), 0);
    const [encoded] = await new ClaimCheckCodec(fakeRedis(), 0).encode([payload]);
    assert.strictEqual(expiries.get(Buffer.from(encoded.data!).toString()), undefined);
  });
});
