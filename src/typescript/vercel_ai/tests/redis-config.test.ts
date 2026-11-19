// The shared Redis config (common/redis-config.ts), which every TypeScript framework uses.
import assert from 'assert';
import { createRedisClient, loadRedisConfig, redisAddress } from '../../common/redis-config';

function options(env: NodeJS.ProcessEnv) {
  const client = createRedisClient(loadRedisConfig(env), { lazyConnect: true });
  const { host, port, password, db } = client.options;
  client.disconnect();
  return { host, port, password, db };
}

describe('Redis config', () => {
  it('defaults to a local Redis without a password', () => {
    assert.deepStrictEqual(options({}), { host: 'localhost', port: 6379, password: null, db: 0 });
  });

  it('reads the host, port and password', () => {
    const env = { REDIS_HOST: 'cache.example', REDIS_PORT: '6380', REDIS_PASSWORD: 's3cret' };
    assert.deepStrictEqual(options(env), { host: 'cache.example', port: 6380, password: 's3cret', db: 0 });
  });

  it('lets REDIS_URL win, and never shows its password', () => {
    const env = { REDIS_HOST: 'ignored.example', REDIS_URL: 'redis://:s3cret@cache.example:6390/2' };
    assert.deepStrictEqual(options(env), { host: 'cache.example', port: 6390, password: 's3cret', db: 2 });
    assert.strictEqual(redisAddress(loadRedisConfig(env)), 'cache.example:6390');
  });
});
