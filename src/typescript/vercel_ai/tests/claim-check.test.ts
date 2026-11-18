// The claim check writes the same payloads as the Python ports and the Java worker, so each can
// read the others' (the Java worker only decodes payloads whose encoding is "claim-checked").
import assert from 'assert';
import type Redis from 'ioredis';
import { temporal } from '@temporalio/proto';
import { ClaimCheckCodec } from '../../common/claim-check-codec';

function fakeRedis(): Redis {
  const store = new Map<string, Buffer>();
  return {
    set: async (key: string, value: Buffer) => void store.set(key, Buffer.from(value)),
    getBuffer: async (key: string) => store.get(key) ?? null,
  } as unknown as Redis;
}

const payload = { metadata: { encoding: Buffer.from('json/plain') }, data: Buffer.from('{"client_id":"123"}') };

describe('claim check codec', () => {
  it('writes the encoding the Python ports and the Java worker use', async () => {
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

  it("reads payloads written with the port's earlier binary/claim-check encoding", async () => {
    const redis = fakeRedis();
    await redis.set('old-id', Buffer.from(temporal.api.common.v1.Payload.encode(payload).finish()));
    const old = {
      metadata: { encoding: Buffer.from('binary/claim-check'), 'temporal.io/claim-check-codec': Buffer.from('v1') },
      data: Buffer.from('old-id'),
    };
    const [decoded] = await new ClaimCheckCodec(redis).decode([old]);
    assert.deepStrictEqual(Buffer.from(decoded.data!), payload.data);
  });

  it('leaves other payloads alone', async () => {
    const [decoded] = await new ClaimCheckCodec(fakeRedis()).decode([payload]);
    assert.strictEqual(decoded, payload);
  });
});
