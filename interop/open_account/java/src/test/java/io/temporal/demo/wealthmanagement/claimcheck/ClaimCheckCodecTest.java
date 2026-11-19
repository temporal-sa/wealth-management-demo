package io.temporal.demo.wealthmanagement.claimcheck;

import com.google.protobuf.ByteString;
import io.temporal.api.common.v1.Payload;
import org.junit.jupiter.api.Test;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.data.redis.core.ValueOperations;

import java.time.Duration;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** Stored payloads expire after CLAIM_CHECK_TTL_SECONDS (default 7 days), as in the frameworks' codecs. */
class ClaimCheckCodecTest {

    private static final Payload PAYLOAD = Payload.newBuilder().setData(ByteString.copyFromUtf8("{}")).build();

    @SuppressWarnings("unchecked")
    private static ValueOperations<String, Payload> encodeWith(long ttlSeconds) {
        RedisTemplate<String, Payload> template = mock(RedisTemplate.class);
        ValueOperations<String, Payload> values = mock(ValueOperations.class);
        when(template.opsForValue()).thenReturn(values);
        new ClaimCheckCodec(template, ttlSeconds).encode(List.of(PAYLOAD));
        return values;
    }

    @Test
    void theExpiryDefaultsToSevenDays() {
        assertEquals(7L * 24 * 60 * 60, ClaimCheckCodec.ttlSeconds(null));
        assertEquals(7L * 24 * 60 * 60, ClaimCheckCodec.ttlSeconds(" "));
        assertEquals(3600, ClaimCheckCodec.ttlSeconds("3600"));
        assertEquals(0, ClaimCheckCodec.ttlSeconds("0"));
    }

    @Test
    void storedPayloadsExpire() {
        verify(encodeWith(3600)).set(anyString(), eq(PAYLOAD), eq(Duration.ofHours(1)));
    }

    @Test
    void zeroKeepsStoredPayloadsForever() {
        ValueOperations<String, Payload> values = encodeWith(0);
        verify(values).set(anyString(), eq(PAYLOAD));
        verify(values, never()).set(anyString(), any(), any(Duration.class));
    }
}
