/**
 * Where the demo's sample bank data (data/*.json) is read from and written to.
 *
 * DEMO_DATA_STORE=file (the default): the JSON files themselves, as when one person runs the demo
 * locally (git checkout data/ resets them).
 *
 * DEMO_DATA_STORE=redis: one copy of each file per browser session (see session-scope.ts), in Redis
 * under data:<session>:<name>, for example data:<session>:investments. A session's first read starts
 * from the file in data/, its writes never touch the file, and its copy expires a day after its last
 * change. This is what a shared, multi-user deployment uses. The Python and Go frameworks use the same
 * keys and format (src/python/common/data_store.py, src/go/internal/common/data).
 */
import * as fs from 'fs';
import * as path from 'path';
import Redis from 'ioredis';
import { createRedisClient } from './redis-config';
import { SESSION_TTL_SECONDS, currentSession } from './session-scope';

export function useRedis(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.DEMO_DATA_STORE ?? 'file').trim().toLowerCase() === 'redis';
}

export function redisKey(sessionId: string, name: string): string {
  return `data:${sessionId}:${name}`;
}

/** The Redis calls the data store makes. */
export type DataStoreRedis = Pick<Redis, 'get' | 'set'>;

let sharedRedis: DataStoreRedis | undefined;

// One connection per process, shared by every activity
function redis(): DataStoreRedis {
  if (!sharedRedis) {
    const client = createRedisClient();
    // Without a listener ioredis reports every failed reconnect as an unhandled error
    client.on('error', () => undefined);
    sharedRedis = client;
  }
  return sharedRedis;
}

/** Replaces the shared Redis client (the tests use an in-memory one); undefined goes back to a real one. */
export function setDataStoreRedis(client: DataStoreRedis | undefined): void {
  sharedRedis = client;
}

export interface JsonDocumentOptions {
  /** The key's name: by default the file's name without .json (clients, beneficiaries, investments or funding_accounts). */
  name?: string;
  /** A fixed session; by default the running activity's, looked up on every load and save. */
  sessionId?: string;
}

/**
 * One sample data file, as the current session sees it.
 *
 * The session is looked up on every load and save, so a document can be created anywhere, even at
 * module load.
 */
export class JsonDocument<T = unknown> {
  readonly name: string;
  private readonly sessionId?: string;

  constructor(
    readonly filePath: string,
    options: JsonDocumentOptions = {},
  ) {
    this.name = options.name ?? path.basename(filePath, '.json');
    this.sessionId = options.sessionId;
  }

  private key(): string {
    return redisKey(this.sessionId ?? currentSession(), this.name);
  }

  private readFile(): T | undefined {
    if (!fs.existsSync(this.filePath)) return undefined;
    const raw = fs.readFileSync(this.filePath, 'utf-8');
    if (raw.length === 0) return undefined;
    return JSON.parse(raw) as T;
  }

  /** The document, or undefined if it doesn't exist or is empty. Throws on invalid JSON. */
  async load(): Promise<T | undefined> {
    if (useRedis()) {
      const raw = await redis().get(this.key());
      if (raw !== null && raw !== undefined) return JSON.parse(raw) as T;
    }
    return this.readFile();
  }

  /**
   * Saves the document: to the session's Redis key with DEMO_DATA_STORE=redis, otherwise to the file,
   * as `format` writes it (by default JSON with a 2-space indent).
   */
  async save(data: T, format: (data: T) => string = (d) => JSON.stringify(d, null, 2)): Promise<void> {
    if (useRedis()) {
      await redis().set(this.key(), JSON.stringify(data), 'EX', SESSION_TTL_SECONDS);
      return;
    }
    fs.writeFileSync(this.filePath, format(data));
  }
}
