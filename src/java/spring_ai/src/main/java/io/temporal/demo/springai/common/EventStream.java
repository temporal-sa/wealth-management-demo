package io.temporal.demo.springai.common;

import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.data.redis.core.StringRedisTemplate;

/**
 * The per-chat event stream the web UI polls (through the API): a Redis list {@code events:<chat workflow ID>}
 * of JSON events {@code {type, content}}, a chat_interaction after each turn and a status_update for each
 * account-opening state change. The same format as the other frameworks (src/python/common/event_stream_manager.py).
 */
public interface EventStream {
    String CHAT_INTERACTION = "chat_interaction";
    String STATUS_UPDATE = "status_update";
    /** How long a chat's events are kept after its last event. */
    Duration TTL = Duration.ofHours(24);

    /** Appends an event and returns the stream's new length. */
    long append(String workflowId, String type, Object content);

    /** Deletes a chat's stream; reports whether there was one. */
    boolean delete(String workflowId);

    static String json(String type, Object content) {
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("type", type);
        event.put("content", content);
        return Json.compact(event);
    }

    /** A stream stored in Redis. */
    final class Redis implements EventStream {
        private final StringRedisTemplate redis;

        public Redis(StringRedisTemplate redis) {
            this.redis = redis;
        }

        @Override
        public long append(String workflowId, String type, Object content) {
            String key = "events:" + workflowId;
            Long length = redis.opsForList().rightPush(key, json(type, content));
            redis.expire(key, TTL);
            return length == null ? 0 : length;
        }

        @Override
        public boolean delete(String workflowId) {
            Long n = redis.delete(List.of("events:" + workflowId, "events:" + workflowId + ":meta"));
            return n != null && n > 0;
        }
    }

    /** A stream kept in memory, for tests. */
    final class InMemory implements EventStream {
        public final Map<String, List<String>> events = new HashMap<>();

        @Override
        public synchronized long append(String workflowId, String type, Object content) {
            List<String> list = events.computeIfAbsent(workflowId, k -> new ArrayList<>());
            list.add(json(type, content));
            return list.size();
        }

        @Override
        public synchronized boolean delete(String workflowId) {
            return events.remove(workflowId) != null;
        }
    }
}
