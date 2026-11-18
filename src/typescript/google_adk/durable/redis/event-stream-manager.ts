/**
 * The conversation the UI polls: a Redis list per chat, events:<workflow ID>, of JSON events
 * {type, content}. The same key and event format as the reference port, so the shared UI reads it.
 */
import Redis from 'ioredis';
import { loadRedisConfig } from '../../common/redis-config';
import type { ChatInteraction, StatusUpdate } from '../shared';

export type StreamEvent =
  { type: 'chat_interaction'; content: ChatInteraction } | { type: 'status_update'; content: StatusUpdate };

export interface EventStream {
  /** Appends an event and returns the new length of the stream. */
  append(workflowId: string, event: StreamEvent): Promise<number>;
  /** The events from `fromIndex` on. */
  getEventsFromIndex(workflowId: string, fromIndex: number): Promise<StreamEvent[]>;
  /** Deletes the conversation. Returns whether there was one. */
  delete(workflowId: string): Promise<boolean>;
}

function streamKey(workflowId: string): string {
  return `events:${workflowId}`;
}

export class RedisEventStream implements EventStream {
  private readonly redis: Redis;

  constructor() {
    this.redis = new Redis({ ...loadRedisConfig(), lazyConnect: true });
    this.redis.on('error', () => undefined);
  }

  append(workflowId: string, event: StreamEvent): Promise<number> {
    return this.redis.rpush(streamKey(workflowId), JSON.stringify(event));
  }

  async getEventsFromIndex(workflowId: string, fromIndex = 0): Promise<StreamEvent[]> {
    const raw = await this.redis.lrange(streamKey(workflowId), fromIndex, -1);
    const events: StreamEvent[] = [];
    for (const item of raw) {
      try {
        events.push(JSON.parse(item) as StreamEvent);
      } catch {
        // skip a malformed event
      }
    }
    return events;
  }

  async delete(workflowId: string): Promise<boolean> {
    return (await this.redis.del(streamKey(workflowId))) > 0;
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}

/** An in-memory event stream, for the tests. */
export class InMemoryEventStream implements EventStream {
  readonly streams = new Map<string, StreamEvent[]>();

  async append(workflowId: string, event: StreamEvent): Promise<number> {
    const list = this.streams.get(workflowId) ?? [];
    list.push(event);
    this.streams.set(workflowId, list);
    return list.length;
  }

  async getEventsFromIndex(workflowId: string, fromIndex = 0): Promise<StreamEvent[]> {
    return (this.streams.get(workflowId) ?? []).slice(fromIndex);
  }

  async delete(workflowId: string): Promise<boolean> {
    return this.streams.delete(workflowId);
  }
}
