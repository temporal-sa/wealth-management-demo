package io.temporal.demo.springai.common;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;

class WorkerInfoTest {
    @Test
    void valueIsTheJsonTheApiReads() throws Exception {
        Map<?, ?> value = new ObjectMapper().readValue(WorkerInfo.value("gemini-3.8-flash"), Map.class);
        assertEquals(Map.of("model", "gemini-3.8-flash"), value);
    }

    @Test
    void aRedisFailureDoesNotStopTheWorker() {
        LettuceConnectionFactory factory = new LettuceConnectionFactory("127.0.0.1", 1);
        factory.afterPropertiesSet();
        try {
            WorkerInfo.publishModel(new StringRedisTemplate(factory), "SpringAI-Supervisor", "gemini-3.8-flash");
        } finally {
            factory.destroy();
        }
    }
}
