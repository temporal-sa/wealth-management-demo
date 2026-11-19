package io.temporal.demo.wealthmanagement.claimcheck;

import com.google.protobuf.ByteString;
import io.temporal.api.common.v1.Payload;
import io.temporal.common.converter.DataConverterException;
import io.temporal.common.converter.EncodingKeys;
import io.temporal.payload.codec.PayloadCodec;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.stereotype.Component;

import javax.annotation.Nonnull;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.UUID;
import java.util.stream.Collectors;

/**
 * Stores each payload in Redis under a new UUID, in the same format as the frameworks' codecs.
 * Stored payloads expire after CLAIM_CHECK_TTL_SECONDS (default 7 days; 0 keeps them forever), so
 * they don't pile up in Redis. A workflow needs its payloads to replay, and the Temporal UI needs
 * them to show its history, so keep the expiry well beyond how long a workflow runs.
 */
@Component
public class ClaimCheckCodec implements PayloadCodec {
    static final long DEFAULT_TTL_SECONDS = 7L * 24 * 60 * 60;

    Logger logger = LoggerFactory.getLogger(ClaimCheckCodec.class);
    private final ByteString METADATA_ENCODING = ByteString.copyFromUtf8("claim-checked");
    private final String CLAIM_CHECK_CODEC_KEY = "temporal.io/claim-check-codec";
    private final String CLAIM_CHECK_CODEC_VERSION = "v1";

    private final RedisTemplate<String, Payload> redisTemplate;
    private final long ttlSeconds;

    @Autowired
    ClaimCheckCodec(RedisTemplate<String, Payload> redisTemplate) {
        this(redisTemplate, ttlSeconds(System.getenv("CLAIM_CHECK_TTL_SECONDS")));
    }

    ClaimCheckCodec(RedisTemplate<String, Payload> redisTemplate, long ttlSeconds) {
        logger.info("Constructing ClaimCheckCodec. RedisTemplate is {}, payloads expire after {}", redisTemplate,
                ttlSeconds > 0 ? ttlSeconds + " seconds" : "never");
        this.redisTemplate = redisTemplate;
        this.ttlSeconds = ttlSeconds;
    }

    /** How long stored payloads are kept, from a CLAIM_CHECK_TTL_SECONDS value; 0 keeps them forever. */
    static long ttlSeconds(String value) {
        if (value == null || value.isBlank()) {
            return DEFAULT_TTL_SECONDS;
        }
        try {
            return Math.max(0, Long.parseLong(value.trim()));
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    @Nonnull
    @Override
    public List<Payload> encode(@Nonnull List<Payload> payloads) {
        return payloads.stream().map(this::encodePayload).collect(Collectors.toList());
    }

    @Nonnull
    @Override
    public List<Payload> decode(@Nonnull List<Payload> payloads) {
        return payloads.stream().map(this::decodePayload).collect(Collectors.toList());
    }

    private Payload encodePayload(Payload payload) {
        String id = UUID.randomUUID().toString();

        if (ttlSeconds > 0) {
            redisTemplate.opsForValue().set(id, payload, Duration.ofSeconds(ttlSeconds));
        } else {
            redisTemplate.opsForValue().set(id, payload);
        }

        return Payload.newBuilder()
                .putMetadata(EncodingKeys.METADATA_ENCODING_KEY,METADATA_ENCODING)
                .putMetadata(CLAIM_CHECK_CODEC_KEY,ByteString.copyFromUtf8(CLAIM_CHECK_CODEC_VERSION))
                .setData(ByteString.copyFromUtf8(id))
                .build();
    }

    private Payload decodePayload(Payload source) {
        // make sure we're dealing with only claim-checked payloads
        logger.info("Incoming payload is {} = {}",
                EncodingKeys.METADATA_ENCODING_KEY,
                source.getMetadataOrDefault(
                        EncodingKeys.METADATA_ENCODING_KEY,
                        ByteString.copyFrom("<missing>",  StandardCharsets.UTF_8)
                ).toStringUtf8());
        if (!METADATA_ENCODING.equals(source.getMetadataOrDefault(EncodingKeys.METADATA_ENCODING_KEY,null))) {
            logger.info("bypassing source as it isn't claim-checked value is {} ", source.getMetadataOrDefault(EncodingKeys.METADATA_ENCODING_KEY,null));
            return source;
        }

        String redisId;
        try {
            // get the redis id
            redisId = source.getData().toStringUtf8();
            logger.info("===> The redis id is {}", redisId);
            // and retrieve the data from Redis
            Payload decodedPayload =  redisTemplate.opsForValue().get(redisId);
            logger.info("The data from Redis is {}", decodedPayload);
            return decodedPayload;
        } catch (Exception ex)
        {
            logger.error("Error when retrieving redis key ", ex);
            throw new DataConverterException(ex);
        }
    }
}
