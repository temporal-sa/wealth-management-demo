import { randomUUID } from 'crypto';
import type Redis from 'ioredis';
import type { PayloadCodec } from '@temporalio/common';
import { temporal } from '@temporalio/proto';

type IPayload = temporal.api.common.v1.IPayload;
const Payload = temporal.api.common.v1.Payload;

const ENCODING_METADATA_KEY = 'temporal.io/claim-check-codec';
const ENCODING_METADATA_VALUE = Buffer.from('v1');
// The encoding every framework's claim check writes (Python's ClaimCheckCodec and the Java worker's). The
// Java worker only decodes payloads with this encoding.
const CLAIM_CHECK_ENCODING = Buffer.from('claim-checked');

export const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * How long stored payloads are kept in Redis (CLAIM_CHECK_TTL_SECONDS, default 7 days), so they don't
 * pile up; 0 (CLAIM_CHECK_TTL_SECONDS=0) keeps them forever. A workflow needs its payloads to
 * replay, and the Temporal UI needs them to show its history, so keep this well beyond how long a
 * workflow runs.
 */
export function claimCheckTtlSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const value = (env.CLAIM_CHECK_TTL_SECONDS ?? '').trim();
  const seconds = value ? Number(value) : DEFAULT_TTL_SECONDS;
  return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
}

export class ClaimCheckCodec implements PayloadCodec {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number = claimCheckTtlSeconds(),
  ) {}

  async encode(payloads: IPayload[]): Promise<IPayload[]> {
    return Promise.all(payloads.map((p) => this.encodePayload(p)));
  }

  async decode(payloads: IPayload[]): Promise<IPayload[]> {
    return Promise.all(payloads.map((p) => this.decodePayload(p)));
  }

  private async encodePayload(payload: IPayload): Promise<IPayload> {
    const claimKey = randomUUID();
    const serialized = Buffer.from(Payload.encode(payload).finish());
    if (this.ttlSeconds > 0) {
      await this.redis.set(claimKey, serialized, 'EX', this.ttlSeconds);
    } else {
      await this.redis.set(claimKey, serialized);
    }
    return {
      metadata: {
        encoding: CLAIM_CHECK_ENCODING,
        [ENCODING_METADATA_KEY]: ENCODING_METADATA_VALUE,
      },
      data: Buffer.from(claimKey),
    };
  }

  private async decodePayload(payload: IPayload): Promise<IPayload> {
    const marker = payload.metadata?.[ENCODING_METADATA_KEY];
    if (!marker || !Buffer.from(marker).equals(ENCODING_METADATA_VALUE)) {
      return payload;
    }
    const claimKey = Buffer.from(payload.data ?? new Uint8Array()).toString();
    const raw = await this.redis.getBuffer(claimKey);
    if (!raw) {
      throw new Error(`Claim check payload not found in Redis for key ${claimKey}`);
    }
    return Payload.decode(raw);
  }
}