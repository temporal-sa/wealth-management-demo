using Temporalio.Client;
using Temporalio.Converters;
using WealthManagement.Common;

namespace WealthManagement.Durable;

/**
 * How this framework connects to Temporal, from the same environment variables as the other frameworks:
 * TEMPORAL_ADDRESS and TEMPORAL_NAMESPACE, with TEMPORAL_API_KEY, or an mTLS certificate and key
 * (TEMPORAL_TLS_CLIENT_CERT_PATH and TEMPORAL_TLS_CLIENT_KEY_PATH), for Temporal Cloud. With USE_CLAIM_CHECK on,
 * every payload goes through the claim check codec.
 */
public static class Connection
{
    public static string Address() => Env.Get("TEMPORAL_ADDRESS", "localhost:7233");

    public static string Namespace() => Env.Get("TEMPORAL_NAMESPACE", "default");

    /** How the client authenticates, for startup messages (never the key itself). */
    public static string Auth()
    {
        if (Env.Get("TEMPORAL_API_KEY") != "") return "API key";
        return Env.Get("TEMPORAL_TLS_CLIENT_CERT_PATH") != "" && Env.Get("TEMPORAL_TLS_CLIENT_KEY_PATH") != "" ? "mTLS" : "none";
    }

    /** The data converter: the default one, through the claim check codec when USE_CLAIM_CHECK is on. */
    public static DataConverter DataConverter() =>
        ClaimCheckSetting.Enabled()
            ? Temporalio.Converters.DataConverter.Default with { PayloadCodec = new ClaimCheckCodec(RedisConfig.Database()) }
            : Temporalio.Converters.DataConverter.Default;

    public static TemporalClientConnectOptions Options()
    {
        var options = new TemporalClientConnectOptions(Address())
        {
            Namespace = Namespace(),
            DataConverter = DataConverter(),
        };
        var apiKey = Env.Get("TEMPORAL_API_KEY");
        var cert = Env.Get("TEMPORAL_TLS_CLIENT_CERT_PATH");
        var key = Env.Get("TEMPORAL_TLS_CLIENT_KEY_PATH");
        if (apiKey != "")
        {
            options.ApiKey = apiKey;
            options.Tls = new TlsOptions();
        }
        else if (cert != "" && key != "")
        {
            options.Tls = new TlsOptions { ClientCert = File.ReadAllBytes(cert), ClientPrivateKey = File.ReadAllBytes(key) };
        }
        return options;
    }

    public static Task<TemporalClient> ConnectAsync() => TemporalClient.ConnectAsync(Options());
}
