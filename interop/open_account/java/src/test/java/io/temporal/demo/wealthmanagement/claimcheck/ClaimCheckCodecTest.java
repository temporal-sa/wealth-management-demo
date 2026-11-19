package io.temporal.demo.wealthmanagement.claimcheck;

import com.google.protobuf.ByteString;
import io.temporal.api.common.v1.Payload;
import io.temporal.common.converter.DataConverterException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.data.redis.core.ValueOperations;

import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * The codec with Redis replaced by a map, so no Redis is needed. It writes the same payloads as the
 * frameworks' codecs (Python, TypeScript, Go), reads theirs, and stores payloads that expire after
 * CLAIM_CHECK_TTL_SECONDS (default 7 days).
 */
class ClaimCheckCodecTest {

    private static final long TTL_SECONDS = 3600;

    private final Map<String, Payload> redis = new HashMap<>();
    private ValueOperations<String, Payload> values;
    private ClaimCheckCodec codec;

    @BeforeEach
    @SuppressWarnings("unchecked")
    void setUp() {
        RedisTemplate<String, Payload> template = mock(RedisTemplate.class);
        values = mock(ValueOperations.class);
        when(template.opsForValue()).thenReturn(values);
        doAnswer(inv -> redis.put(inv.getArgument(0), inv.getArgument(1)))
                .when(values).set(anyString(), any(Payload.class), any(Duration.class));
        doAnswer(inv -> redis.put(inv.getArgument(0), inv.getArgument(1)))
                .when(values).set(anyString(), any(Payload.class));
        when(values.get(any())).thenAnswer(inv -> redis.get((String) inv.getArgument(0)));
        codec = new ClaimCheckCodec(template, TTL_SECONDS);
    }

    private static Payload payload(String json) {
        return Payload.newBuilder()
                .putMetadata("encoding", ByteString.copyFromUtf8("json/plain"))
                .setData(ByteString.copyFromUtf8(json))
                .build();
    }

    private static Payload claimCheck(String key, boolean withEncoding, boolean withVersion) {
        Payload.Builder builder = Payload.newBuilder().setData(ByteString.copyFromUtf8(key));
        if (withEncoding) {
            builder.putMetadata("encoding", ByteString.copyFromUtf8("claim-checked"));
        }
        if (withVersion) {
            builder.putMetadata("temporal.io/claim-check-codec", ByteString.copyFromUtf8("v1"));
        }
        return builder.build();
    }

    @Test
    void encodeStoresThePayloadAndSendsOnlyItsKey() {
        Payload original = payload("{\"client_id\": \"123\"}");

        Payload encoded = codec.encode(List.of(original)).get(0);

        assertEquals("claim-checked", encoded.getMetadataOrThrow("encoding").toStringUtf8());
        assertEquals("v1", encoded.getMetadataOrThrow("temporal.io/claim-check-codec").toStringUtf8());
        String key = encoded.getData().toStringUtf8();
        UUID.fromString(key);
        assertEquals(original, redis.get(key));
        assertEquals(List.of(original), codec.decode(List.of(encoded)));
    }

    @Test
    void decodesWhatTheFrameworksCodecsWrite() {
        // The frameworks' codecs write both metadata keys; older payloads may have only one of them.
        Payload original = payload("{\"account_name\": \"Vacation\"}");
        redis.put("framework-key", original);
        for (Payload fromFramework : List.of(claimCheck("framework-key", true, true),
                claimCheck("framework-key", true, false), claimCheck("framework-key", false, true))) {
            assertEquals(List.of(original), codec.decode(List.of(fromFramework)), fromFramework.getMetadataMap().toString());
        }
    }

    @Test
    void payloadsThatWereNotClaimCheckedPassThrough() {
        Payload plain = payload("\"hello\"");
        assertEquals(List.of(plain), codec.decode(List.of(plain)));
    }

    @Test
    void aMissingClaimCheckFailsClearly() {
        DataConverterException e = assertThrows(DataConverterException.class,
                () -> codec.decode(List.of(claimCheck("no-such-key", true, true))));
        assertTrue(e.getMessage().contains("no-such-key not found in Redis"), e.getMessage());
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
        codec.encode(List.of(payload("{}")));
        verify(values).set(anyString(), any(Payload.class), eq(Duration.ofHours(1)));
    }

    @Test
    @SuppressWarnings("unchecked")
    void zeroKeepsStoredPayloadsForever() {
        RedisTemplate<String, Payload> template = mock(RedisTemplate.class);
        ValueOperations<String, Payload> forever = mock(ValueOperations.class);
        when(template.opsForValue()).thenReturn(forever);

        new ClaimCheckCodec(template, 0).encode(List.of(payload("{}")));

        verify(forever).set(anyString(), any(Payload.class));
        verify(forever, never()).set(anyString(), any(), any(Duration.class));
    }
}
