package io.temporal.demo.springai.common;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.StringRedisTemplate;

/**
 * Records which model this worker uses, for the web UI's sidebar: the same Redis hash the Python workers write
 * (src/python/common/worker_info.py). Key {@link #KEY}, field the chat task queue, value JSON {"model": ...}. The
 * API reads it for the frameworks whose workers are polling.
 */
public final class WorkerInfo {
    private static final Logger log = LoggerFactory.getLogger(WorkerInfo.class);
    private static final ObjectMapper JSON = new ObjectMapper();

    /** The Redis hash of every worker's model, by chat task queue. */
    public static final String KEY = "worker-info";

    private WorkerInfo() {}

    /** The hash value for a model: JSON {"model": ...}. */
    static String value(String model) {
        try {
            return JSON.writeValueAsString(Map.of("model", model));
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Records this worker's model. A Redis failure is logged and ignored: the worker runs without it. */
    public static void publishModel(StringRedisTemplate redis, String taskQueue, String model) {
        try {
            redis.opsForHash().put(KEY, taskQueue, value(model));
        } catch (RuntimeException e) {
            log.warn("Couldn't record the model in Redis, so the web UI won't show it: {}", e.getMessage());
        }
    }
}
