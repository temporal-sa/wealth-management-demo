package io.temporal.demo.wealthmanagement.common;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

/** USE_CLAIM_CHECK must mean the same thing here as in the Python components (common/util.py str_to_bool). */
class ServerInfoTest {

    @Test
    void acceptsTheSameTrueValuesAsPython() {
        for (String value : new String[] {"true", "TRUE", "True", "t", "yes", "YES", "y", "1", " 1 "}) {
            assertTrue(ServerInfo.isTrue(value), value);
        }
    }

    @Test
    void theOpenAccountQueueDefaultsToThePortsOwn() {
        for (String value : new String[] {null, "", "  ", "java", "Java", " JAVA "}) {
            assertEquals("OAI-Supervisor-open-account", ServerInfo.openAccountTaskQueue("OAI-Supervisor", value),
                    String.valueOf(value));
        }
        assertEquals("ADK-Go-Supervisor-open-account", ServerInfo.openAccountTaskQueue("ADK-Go-Supervisor", "java"));
    }

    @Test
    void anOpenAccountQueueNameIsUsedAsGiven() {
        assertEquals("My-Queue", ServerInfo.openAccountTaskQueue("OAI-Supervisor", "My-Queue"));
    }

    @Test
    void everythingElseIsOff() {
        for (String value : new String[] {"false", "f", "no", "n", "0", "", "on", "2", null}) {
            assertFalse(ServerInfo.isTrue(value), String.valueOf(value));
        }
    }

    @Test
    void theClaimCheckRedisComesFromTheUrlWhenSetWithoutItsPassword() {
        assertEquals("cache.example:6390", ServerInfo.redisAddress("redis://:s3cret@cache.example:6390/0", "localhost", "6379"));
        assertEquals("cache.example:6379", ServerInfo.redisAddress("redis://cache.example", "localhost", "6379"));
        assertEquals("localhost:16379", ServerInfo.redisAddress(null, "localhost", "16379"));
        assertEquals("localhost:16379", ServerInfo.redisAddress(" ", "localhost", "16379"));
    }
}
