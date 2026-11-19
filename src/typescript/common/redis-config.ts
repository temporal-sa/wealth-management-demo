import Redis, { RedisOptions } from 'ioredis';

const DEFAULT_HOST = 'localhost';
const DEFAULT_PORT = 6379;

/** How long a chat's event stream (events:<workflow ID>) is kept after its last event, so abandoned chats don't pile up. */
export const STREAM_TTL_SECONDS = 24 * 60 * 60;

/**
 * Where Redis is, from the environment. REDIS_URL (redis://:<password>@<host>:<port>/<db>)
 * wins when it is set; otherwise REDIS_HOST, REDIS_PORT and the optional REDIS_PASSWORD are
 * used. Locally nothing needs to be set: the default is an unauthenticated Redis on
 * localhost:6379.
 */
export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  url?: string;
}

export function loadRedisConfig(env: NodeJS.ProcessEnv = process.env): RedisConfig {
  return {
    host: env.REDIS_HOST || DEFAULT_HOST,
    port: Number(env.REDIS_PORT || DEFAULT_PORT),
    password: env.REDIS_PASSWORD || undefined,
    url: env.REDIS_URL || undefined,
  };
}

/** Where Redis is, for startup messages (never includes the password). */
export function redisAddress(config: RedisConfig = loadRedisConfig()): string {
  if (config.url) {
    try {
      const url = new URL(config.url);
      return `${url.hostname || DEFAULT_HOST}:${url.port || DEFAULT_PORT}`;
    } catch {
      return 'REDIS_URL (unparseable)';
    }
  }
  return `${config.host}:${config.port}`;
}

/** A Redis client for the config; `options` adds client settings such as lazyConnect. */
export function createRedisClient(config: RedisConfig = loadRedisConfig(), options: RedisOptions = {}): Redis {
  if (config.url) {
    return new Redis(config.url, options);
  }
  return new Redis({ host: config.host, port: config.port, password: config.password, ...options });
}
