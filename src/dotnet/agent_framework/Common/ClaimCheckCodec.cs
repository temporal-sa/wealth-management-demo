using Google.Protobuf;
using StackExchange.Redis;
using Temporalio.Api.Common.V1;
using Temporalio.Converters;

namespace WealthManagement.Common;

/**
 * The claim check: stores each payload in Redis under a new UUID and puts only the UUID in Temporal, in the same
 * format as every other framework's codec and the Java worker's (the serialized payload as the Redis value, and
 * the metadata encoding "claim-checked" and temporal.io/claim-check-codec "v1"), so a workflow started by one can
 * run on another. Stored payloads expire after CLAIM_CHECK_TTL_SECONDS (default 7 days; 0 keeps them forever). A
 * workflow needs its payloads to replay, and the Temporal UI to show its history, so keep the expiry well beyond
 * how long a workflow runs.
 */
public sealed class ClaimCheckCodec(IDatabase redis, long ttlSeconds) : IPayloadCodec
{
    public const long DefaultTtlSeconds = 7L * 24 * 60 * 60;
    private const string CodecKey = "temporal.io/claim-check-codec";
    private static readonly ByteString Encoding = ByteString.CopyFromUtf8("claim-checked");
    private static readonly ByteString Version = ByteString.CopyFromUtf8("v1");

    public ClaimCheckCodec(IDatabase redis) : this(redis, TtlSeconds(Environment.GetEnvironmentVariable("CLAIM_CHECK_TTL_SECONDS")))
    {
    }

    /** How long stored payloads are kept, from a CLAIM_CHECK_TTL_SECONDS value; 0 keeps them forever. */
    public static long TtlSeconds(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return DefaultTtlSeconds;
        return long.TryParse(value.Trim(), out var seconds) ? Math.Max(0, seconds) : 0;
    }

    public async Task<IReadOnlyCollection<Payload>> EncodeAsync(IReadOnlyCollection<Payload> payloads)
    {
        var encoded = new List<Payload>(payloads.Count);
        foreach (var payload in payloads)
        {
            var key = Guid.NewGuid().ToString();
            if (ttlSeconds > 0) await redis.StringSetAsync(key, payload.ToByteArray(), TimeSpan.FromSeconds(ttlSeconds));
            else await redis.StringSetAsync(key, payload.ToByteArray());
            encoded.Add(new Payload
            {
                Metadata = { ["encoding"] = Encoding, [CodecKey] = Version },
                Data = ByteString.CopyFromUtf8(key),
            });
        }
        return encoded;
    }

    public async Task<IReadOnlyCollection<Payload>> DecodeAsync(IReadOnlyCollection<Payload> payloads)
    {
        var decoded = new List<Payload>(payloads.Count);
        foreach (var payload in payloads)
        {
            // Payloads that weren't claim-checked pass through unchanged
            var claimChecked = (payload.Metadata.TryGetValue("encoding", out var e) && e.Equals(Encoding))
                || (payload.Metadata.TryGetValue(CodecKey, out var v) && v.Equals(Version));
            if (!claimChecked)
            {
                decoded.Add(payload);
                continue;
            }
            var key = payload.Data.ToStringUtf8();
            var raw = await redis.StringGetAsync(key);
            if (!raw.HasValue)
            {
                throw new InvalidOperationException(
                    $"Claim check {key} not found in Redis (it may have expired, see CLAIM_CHECK_TTL_SECONDS): the payload can't be decoded");
            }
            decoded.Add(Payload.Parser.ParseFrom((byte[])raw!));
        }
        return decoded;
    }
}
