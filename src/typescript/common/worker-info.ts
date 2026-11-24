/**
 * Which model each framework's worker uses, for the web UI's sidebar: the same Redis hash the Python
 * workers write (src/python/common/worker_info.py). Key WORKER_INFO_KEY, field the chat task queue,
 * value JSON {"model": ...}. The API reads it for the frameworks whose workers are polling.
 */
import { createRedisClient, RedisConfig, loadRedisConfig } from './redis-config';

export const WORKER_INFO_KEY = 'worker-info';

/** Records this worker's model. A Redis failure is reported and ignored: the worker runs without it. */
export async function publishWorkerModel(
  taskQueue: string,
  model: string,
  config: RedisConfig = loadRedisConfig(),
): Promise<void> {
  const client = createRedisClient(config, { lazyConnect: true, maxRetriesPerRequest: 1 });
  // A failed connection is reported once, below, not as unhandled error events
  client.on('error', () => {});
  try {
    await client.connect();
    await client.hset(WORKER_INFO_KEY, taskQueue, JSON.stringify({ model }));
  } catch (e) {
    console.error(`Couldn't record the model in Redis, so the web UI won't show it: ${e}`);
  } finally {
    client.disconnect();
  }
}
