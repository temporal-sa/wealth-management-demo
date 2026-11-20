package io.temporal.demo.springai.worker;

import io.temporal.client.WorkflowClient;
import io.temporal.client.WorkflowClientOptions;
import io.temporal.common.converter.CodecDataConverter;
import io.temporal.common.converter.DefaultDataConverter;
import io.temporal.payload.codec.PayloadCodec;
import io.temporal.serviceclient.SimpleSslContextBuilder;
import io.temporal.serviceclient.WorkflowServiceStubs;
import io.temporal.serviceclient.WorkflowServiceStubsOptions;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.util.List;
import java.util.Locale;

/**
 * How this framework connects to Temporal, from the same environment variables as the other frameworks:
 * TEMPORAL_ADDRESS and TEMPORAL_NAMESPACE, with TEMPORAL_API_KEY, or an mTLS certificate and key
 * (TEMPORAL_TLS_CLIENT_CERT_PATH, and TEMPORAL_KEY_PKCS8_PATH or TEMPORAL_TLS_CLIENT_KEY_PATH, in PKCS8),
 * for Temporal Cloud. With USE_CLAIM_CHECK on, every payload goes through the claim check codec.
 */
public final class Connection {
    private Connection() {
    }

    public static String address() {
        return env("TEMPORAL_ADDRESS", "127.0.0.1:7233");
    }

    public static String namespace() {
        return env("TEMPORAL_NAMESPACE", "default");
    }

    static String apiKey() {
        return env("TEMPORAL_API_KEY", "");
    }

    static String certPath() {
        return env("TEMPORAL_TLS_CLIENT_CERT_PATH", "");
    }

    static String keyPath() {
        return env("TEMPORAL_KEY_PKCS8_PATH", env("TEMPORAL_TLS_CLIENT_KEY_PATH", ""));
    }

    /** How the client authenticates, for startup messages (never the key itself). */
    public static String auth() {
        if (!apiKey().isEmpty()) {
            return "API key";
        }
        return !certPath().isEmpty() && !keyPath().isEmpty() ? "mTLS" : "none";
    }

    /** Whether USE_CLAIM_CHECK is on (true, t, yes, y or 1, in any case), as the other components read it. */
    public static boolean useClaimCheck() {
        return switch (env("USE_CLAIM_CHECK", "false").trim().toLowerCase(Locale.ROOT)) {
            case "true", "t", "yes", "y", "1", "on" -> true;
            default -> false;
        };
    }

    public static WorkflowClient connect(PayloadCodec claimCheckCodec) {
        WorkflowServiceStubsOptions.Builder stubs = WorkflowServiceStubsOptions.newBuilder().setTarget(address());
        if (!apiKey().isEmpty()) {
            stubs.addApiKey(Connection::apiKey).setEnableHttps(true);
        } else if (!certPath().isEmpty() && !keyPath().isEmpty()) {
            try (InputStream cert = new FileInputStream(certPath()); InputStream key = new FileInputStream(keyPath())) {
                stubs.setSslContext(SimpleSslContextBuilder.forPKCS8(cert, key).build());
            } catch (IOException e) {
                throw new UncheckedIOException(e);
            }
        }
        WorkflowClientOptions.Builder options = WorkflowClientOptions.newBuilder().setNamespace(namespace());
        if (useClaimCheck()) {
            options.setDataConverter(new CodecDataConverter(DefaultDataConverter.newDefaultInstance(),
                    List.of(claimCheckCodec)));
        }
        return WorkflowClient.newInstance(WorkflowServiceStubs.newServiceStubs(stubs.build()), options.build());
    }

    public static String claimCheckStatus() {
        if (!useClaimCheck()) {
            return "Claim check: off";
        }
        return "Claim check: ON (payloads stored in Redis at " + env("REDIS_HOST", "localhost") + ":"
                + env("REDIS_PORT", "6379") + ")";
    }

    static String env(String name, String defaultValue) {
        String value = System.getenv(name);
        return value != null && !value.isBlank() ? value.trim() : defaultValue;
    }
}
