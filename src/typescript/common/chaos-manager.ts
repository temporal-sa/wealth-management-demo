import Redis from 'ioredis';
import { createRedisClient } from './redis-config';
import { SESSION_TTL_SECONDS, currentSession } from './session-scope';

export enum ChaosFlag {
  TOOL_DOWN = 'tool_down',
  LLM_DOWN = 'llm_down',
  LLM_RATE_LIMITED = 'llm_rate_limited',
  CUSTODIAN_REJECTS = 'custodian_rejects',
  SLOW_SAGA = 'slow_saga',
  WORKFLOW_BUG = 'workflow_bug',
}

export interface ChaosFlagInfo {
  flag: ChaosFlag;
  label: string;
  description: string;
}

export interface ChaosEvent {
  timestamp: number; // seconds since the epoch
  flag: ChaosFlag;
  source: string;
  attempt?: number;
  workflow_id?: string;
}

// Display metadata for the UI chaos panel, in the order it is shown.
export const CHAOS_FLAGS: ChaosFlagInfo[] = [
  {
    flag: ChaosFlag.TOOL_DOWN,
    label: 'Core banking API down',
    description:
      'Investment and beneficiary tools raise a connection error. Temporal retries until you turn this off.',
  },
  {
    flag: ChaosFlag.LLM_DOWN,
    label: 'Gemini API down',
    description:
      'Every model call raises a connection error. The agent pauses mid-turn and resumes when you turn this off.',
  },
  {
    flag: ChaosFlag.LLM_RATE_LIMITED,
    label: 'Gemini rate limited (429)',
    description:
      "Every model call is throttled. Retries wait for the server's Retry-After delay instead of the normal backoff.",
  },
  {
    flag: ChaosFlag.CUSTODIAN_REJECTS,
    label: 'Custodian rejects new accounts',
    description:
      'The last account-opening step fails non-retryably, so the saga rolls back the funds transfer and the account.',
  },
  {
    flag: ChaosFlag.SLOW_SAGA,
    label: 'Slow account-opening steps',
    description:
      'Each account-opening step takes a few extra seconds, so you can watch the saga (or kill the worker mid-way).',
  },
  {
    flag: ChaosFlag.WORKFLOW_BUG,
    label: 'Bug in workflow code',
    description:
      "New account openings get a welcome-bonus promo code, and the workflow's promo code path has a bug. " +
      'It pauses after compliance approval until you fix the code and restart the worker. ' +
      'Turning this off does not unstick openings that already have the promo code.',
  },
];

const MAX_EVENTS = 50;

export function flagsKey(sessionId: string): string {
  return `chaos:${sessionId}:flags`;
}

export function eventsKey(sessionId: string): string {
  return `chaos:${sessionId}:events`;
}

export interface ChaosManagerOptions {
  /** A fixed browser session (the API passes the caller's); by default the running activity's, looked up on every call. */
  sessionId?: string;
  /** The Redis client to use (the tests pass an in-memory one); by default a new one from the environment. */
  redis?: Redis;
}

/**
 * Stores failure-injection flags, and a log of the failures they caused, in Redis.
 *
 * Flags are read at runtime by activities and the model wrapper, so a failure can
 * be switched on and off from the UI without restarting the worker.
 *
 * Each browser session has its own flags and log (session-scope.ts), expiring a day after their last
 * change. In an activity the session comes from the running workflow's ID, so a flag only affects the
 * chats of the browser that turned it on. Outside an activity, with no session given, it is "default".
 */
export class ChaosManager {
  private readonly redis: Redis;
  private readonly sessionId?: string;

  constructor(options: ChaosManagerOptions = {}) {
    this.sessionId = options.sessionId;
    if (options.redis) {
      this.redis = options.redis;
    } else {
      // Give up quickly when Redis is down, so callers can fail open instead of hanging
      this.redis = createRedisClient(undefined, { maxRetriesPerRequest: 1 });
      // Without a listener ioredis reports every failed reconnect as an unhandled error
      this.redis.on('error', () => undefined);
    }
  }

  private session(): string {
    return this.sessionId ?? currentSession();
  }

  async isEnabled(flag: ChaosFlag): Promise<boolean> {
    return (await this.redis.hget(flagsKey(this.session()), flag)) === '1';
  }

  async setEnabled(flag: ChaosFlag, enabled: boolean): Promise<void> {
    const key = flagsKey(this.session());
    if (enabled) {
      await this.redis.hset(key, flag, '1');
      await this.redis.expire(key, SESSION_TTL_SECONDS);
    } else {
      await this.redis.hdel(key, flag);
    }
  }

  async getFlags(): Promise<Array<ChaosFlagInfo & { enabled: boolean }>> {
    const enabled = await this.redis.hgetall(flagsKey(this.session()));
    return CHAOS_FLAGS.map((info) => ({ ...info, enabled: enabled[info.flag] === '1' }));
  }

  async recordEvent(event: Omit<ChaosEvent, 'timestamp'>): Promise<void> {
    const entry: ChaosEvent = { timestamp: Date.now() / 1000, ...event };
    const key = eventsKey(this.session());
    await this.redis.lpush(key, JSON.stringify(entry));
    await this.redis.ltrim(key, 0, MAX_EVENTS - 1);
    await this.redis.expire(key, SESSION_TTL_SECONDS);
  }

  async getEvents(limit = 20): Promise<ChaosEvent[]> {
    const raw = await this.redis.lrange(eventsKey(this.session()), 0, limit - 1);
    return raw.map((e) => JSON.parse(e) as ChaosEvent);
  }

  // Clears the session's failure log
  async clearEvents(): Promise<void> {
    await this.redis.del(eventsKey(this.session()));
  }

  // Turns every flag of the session off and clears its failure log
  async reset(): Promise<void> {
    const session = this.session();
    await this.redis.del(flagsKey(session), eventsKey(session));
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}

export function isChaosFlag(value: string): value is ChaosFlag {
  return (Object.values(ChaosFlag) as string[]).includes(value);
}
