package io.temporal.demo.wealthmanagement.common;

import io.temporal.client.WorkflowClient;
import io.temporal.client.WorkflowClientOptions;
import io.temporal.common.converter.CodecDataConverter;
import io.temporal.common.converter.DefaultDataConverter;
import io.temporal.demo.wealthmanagement.claimcheck.ClaimCheckCodec;
import io.temporal.payload.codec.PayloadCodec;
import io.temporal.serviceclient.SimpleSslContextBuilder;
import io.temporal.serviceclient.WorkflowServiceStubs;
import io.temporal.serviceclient.WorkflowServiceStubsOptions;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import jakarta.annotation.PostConstruct;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Collections;

/**
 * The client the status activity uses to signal the parent chat workflow. The worker itself uses the
 * Spring-configured client (application*.yaml); this one is built from the same environment variables:
 * TEMPORAL_ADDRESS and TEMPORAL_NAMESPACE, with TEMPORAL_API_KEY or an mTLS certificate and key when they
 * are set, and the same data converter as the worker's client (the claim check codec, when it is on).
 */
@Component
public class TemporalClient {

    @Autowired
    private ClaimCheckCodec claimCheckCodec;

    private static TemporalClient instance; // Not ideal
    private static volatile WorkflowClient client;

    @PostConstruct
    public void init() {
        instance = this;
    }

    public static ClaimCheckCodec getClaimCheckCodec() {
        return instance != null ? instance.claimCheckCodec : null;
    }

    /** One client for the process, created on first use and reused for every status update. */
    public static WorkflowClient get() throws IOException {
        if (client == null) {
            synchronized (TemporalClient.class) {
                if (client == null) {
                    System.out.println("Temporal client for status updates: " + ServerInfo.getServerInfo());
                    WorkflowServiceStubs service = WorkflowServiceStubs.newServiceStubs(serviceStubsOptions(
                            ServerInfo.getAddress(), ServerInfo.getApiKey(), ServerInfo.getCertPath(),
                            ServerInfo.getKeyPath()));
                    client = WorkflowClient.newInstance(service,
                            clientOptions(ServerInfo.getNamespace(), ServerInfo.useClaimCheck(), getClaimCheckCodec()));
                }
            }
        }
        return client;
    }

    /**
     * How to reach Temporal: with the API key when there is one (Temporal Cloud, over TLS), otherwise
     * with the mTLS certificate and key when both are set, otherwise plainly (a local server).
     */
    static WorkflowServiceStubsOptions serviceStubsOptions(String address, String apiKey, String certPath,
            String keyPath) throws IOException {
        WorkflowServiceStubsOptions.Builder builder = WorkflowServiceStubsOptions.newBuilder().setTarget(address);
        if (!apiKey.isEmpty()) {
            builder.addApiKey(() -> apiKey).setEnableHttps(true);
        } else if (!certPath.isEmpty() && !keyPath.isEmpty()) {
            try (InputStream cert = new FileInputStream(certPath); InputStream key = new FileInputStream(keyPath)) {
                builder.setSslContext(SimpleSslContextBuilder.forPKCS8(cert, key).build());
            }
        }
        return builder.build();
    }

    /**
     * Options for the namespace, with the same claim check data converter as the Spring-configured
     * worker client (claimcheck/TemporalOptionsConfig) when claim check is on. Without it, a signal
     * sent with this client would carry the raw payload while the worker expects claim-checked data.
     */
    static WorkflowClientOptions clientOptions(String namespace, boolean useClaimCheck, PayloadCodec codec) {
        WorkflowClientOptions.Builder builder = WorkflowClientOptions.newBuilder().setNamespace(namespace);
        if (useClaimCheck) {
            if (codec == null) {
                throw new IllegalStateException(
                        "USE_CLAIM_CHECK is true but no ClaimCheckCodec is available (Spring context not initialized)");
            }
            builder.setDataConverter(new CodecDataConverter(
                    DefaultDataConverter.newDefaultInstance(), Collections.singletonList(codec)));
        }
        return builder.build();
    }
}
