package io.temporal.demo.wealthmanagement.common;

import io.temporal.api.common.v1.Payload;
import io.temporal.client.WorkflowClientOptions;
import io.temporal.common.converter.CodecDataConverter;
import io.temporal.payload.codec.PayloadCodec;
import io.temporal.serviceclient.GrpcMetadataProvider;
import io.temporal.serviceclient.WorkflowServiceStubsOptions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class TemporalClientTest {

    private static final PayloadCodec IDENTITY_CODEC = new PayloadCodec() {
        @Override
        public List<Payload> encode(List<Payload> payloads) {
            return payloads;
        }

        @Override
        public List<Payload> decode(List<Payload> payloads) {
            return payloads;
        }
    };

    @Test
    void claimCheckOnUsesCodecDataConverter() {
        WorkflowClientOptions options = TemporalClient.clientOptions("ns", true, IDENTITY_CODEC);
        assertEquals("ns", options.getNamespace());
        assertInstanceOf(CodecDataConverter.class, options.getDataConverter());
    }

    @Test
    void claimCheckOffKeepsDefaultConverterAndAllowsNullCodec() {
        WorkflowClientOptions options = TemporalClient.clientOptions("ns", false, null);
        assertEquals("ns", options.getNamespace());
        assertFalse(options.getDataConverter() instanceof CodecDataConverter);
    }

    @Test
    void claimCheckOnWithoutCodecFailsClearly() {
        assertThrows(IllegalStateException.class, () -> TemporalClient.clientOptions("ns", true, null));
    }

    @Test
    void anApiKeyConnectsOverTlsWithTheKey() throws Exception {
        WorkflowServiceStubsOptions options =
                TemporalClient.serviceStubsOptions("ns.acct.tmprl.cloud:7233", "the-key", "", "");
        assertEquals("ns.acct.tmprl.cloud:7233", options.getTarget());
        assertTrue(options.getEnableHttps());
        assertNull(options.getSslContext());
        GrpcMetadataProvider provider = options.getGrpcMetadataProviders().iterator().next();
        assertEquals("Bearer the-key", provider.getMetadata().get(
                io.grpc.Metadata.Key.of("Authorization", io.grpc.Metadata.ASCII_STRING_MARSHALLER)));
    }

    @Test
    void aCertificateAndKeyConnectWithMtls(@TempDir Path dir) throws Exception {
        Path key = dir.resolve("key.pem");
        Path cert = dir.resolve("cert.pem");
        run("openssl", "genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", key.toString());
        run("openssl", "req", "-x509", "-key", key.toString(), "-subj", "/CN=test", "-days", "1", "-out", cert.toString());
        WorkflowServiceStubsOptions options =
                TemporalClient.serviceStubsOptions("ns.acct.tmprl.cloud:7233", "", cert.toString(), key.toString());
        assertNotNull(options.getSslContext());
        assertTrue(options.getGrpcMetadataProviders() == null || options.getGrpcMetadataProviders().isEmpty());
    }

    @Test
    void withNeitherItConnectsPlainly() throws Exception {
        WorkflowServiceStubsOptions options = TemporalClient.serviceStubsOptions("127.0.0.1:7233", "", "", "");
        assertEquals("127.0.0.1:7233", options.getTarget());
        assertFalse(options.getEnableHttps());
        assertNull(options.getSslContext());
    }

    private static void run(String... command) throws Exception {
        Process process = new ProcessBuilder(command).redirectErrorStream(true).start();
        process.getInputStream().readAllBytes();
        assertEquals(0, process.waitFor(), String.join(" ", command));
    }
}
