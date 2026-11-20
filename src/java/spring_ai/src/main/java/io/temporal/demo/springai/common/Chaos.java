package io.temporal.demo.springai.common;

import io.temporal.activity.Activity;
import io.temporal.activity.ActivityInfo;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.StringRedisTemplate;

/**
 * The demo's failure injection, driven by the flags in the web UI's chaos panel.
 *
 * <p>The flags live in the Redis hash {@code chaos:<session>:flags} (field = flag name, "1" when on) and are
 * read on every activity attempt, including every model call, so a failure is switched on and off with no
 * restart. If Redis can't be reached, every flag reads as off. Each injected failure is logged to the list
 * {@code chaos:<session>:events} (the last 50) for the panel. The same keys as the other frameworks
 * (src/python/common/chaos_manager.py). Called from activities only, never from workflow code.
 */
public interface Chaos {
    String TOOL_DOWN = "tool_down";
    String LLM_DOWN = "llm_down";
    String LLM_RATE_LIMITED = "llm_rate_limited";
    String CUSTODIAN_REJECTS = "custodian_rejects";
    String SLOW_SAGA = "slow_saga";
    String WORKFLOW_BUG = "workflow_bug";
    /** How long each saga step sleeps while SLOW_SAGA is on. */
    Duration SLOW_SAGA_DELAY = Duration.ofSeconds(4);

    boolean isEnabled(String flag);

    void recordEvent(String flag);

    /** Throws {@code error} if the flag is on, after logging the failure for the chaos panel. */
    default void inject(String flag, RuntimeException error) {
        if (!isEnabled(flag)) {
            return;
        }
        recordEvent(flag);
        LoggerFactory.getLogger(Chaos.class).warn("Chaos [{}]: {}", flag, error.getMessage());
        throw error;
    }

    /** Fails the way the core banking API would while TOOL_DOWN is on. */
    default void coreBankingApi() {
        inject(TOOL_DOWN, new IllegalStateException("Connection error: Core banking API unavailable"));
    }

    /** Sleeps SLOW_SAGA_DELAY while SLOW_SAGA is on, simulating a slow downstream system. */
    default void maybeSlowDown() {
        if (isEnabled(SLOW_SAGA)) {
            try {
                Thread.sleep(SLOW_SAGA_DELAY);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
    }

    /** Every flag off. */
    Chaos OFF = new Chaos() {
        @Override
        public boolean isEnabled(String flag) {
            return false;
        }

        @Override
        public void recordEvent(String flag) {
        }
    };

    /** The flags of the running activity's session, in Redis. */
    final class Redis implements Chaos {
        private static final Logger log = LoggerFactory.getLogger(Redis.class);
        private static final int MAX_EVENTS = 50;
        private final StringRedisTemplate redis;

        public Redis(StringRedisTemplate redis) {
            this.redis = redis;
        }

        @Override
        public boolean isEnabled(String flag) {
            try {
                return "1".equals(redis.opsForHash().get("chaos:" + Session.current() + ":flags", flag));
            } catch (RuntimeException e) {
                // Fail open: if Redis is unreachable, chaos is off rather than breaking the demo.
                log.warn("Could not read chaos flag {}: {}", flag, e.getMessage());
                return false;
            }
        }

        @Override
        public void recordEvent(String flag) {
            Map<String, Object> event = new LinkedHashMap<>();
            event.put("timestamp", System.currentTimeMillis() / 1000.0);
            event.put("flag", flag);
            try {
                ActivityInfo info = Activity.getExecutionContext().getInfo();
                event.put("source", info.getActivityType());
                event.put("attempt", info.getAttempt());
                event.put("workflow_id", info.getWorkflowId());
            } catch (RuntimeException notInAnActivity) {
                event.put("source", "");
                event.put("attempt", 0);
                event.put("workflow_id", "");
            }
            String key = "chaos:" + Session.current() + ":events";
            try {
                redis.opsForList().leftPush(key, Json.compact(event));
                redis.opsForList().trim(key, 0, MAX_EVENTS - 1);
                redis.expire(key, Session.TTL);
            } catch (RuntimeException e) {
                log.warn("Could not record chaos event: {}", e.getMessage());
            }
        }
    }

    /** Flags turned on by a test. */
    final class Fixed implements Chaos {
        public final Set<String> enabled;

        public Fixed(Set<String> enabled) {
            this.enabled = enabled;
        }

        @Override
        public boolean isEnabled(String flag) {
            return enabled.contains(flag);
        }

        @Override
        public void recordEvent(String flag) {
        }
    }
}
