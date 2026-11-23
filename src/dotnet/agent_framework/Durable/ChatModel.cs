using System.ClientModel;
using System.ClientModel.Primitives;
using Microsoft.Extensions.AI;
using OpenAI;
using WealthManagement.Common;

namespace WealthManagement.Durable;

/**
 * The model the worker's model activity calls: OpenAI's chat client, with the chaos panel's model flags.
 *
 * Temporal's Microsoft Agent Framework integration builds the chat client on the worker from the plugin's factory
 * and runs every model call in its model activity (MicrosoftAgentFramework.InvokeModel), so GetResponseAsync runs
 * inside that activity, where the chaos flags of the chat's browser session are found from the activity's
 * workflow ID.
 *
 * The integration classifies a provider error by its HTTP status: 429 and 5xx are retried, other 4xx are not, and
 * the Retry-After header becomes the next retry delay. So "LLM rate limited" throws the OpenAI client's own
 * ClientResultException with status 429 and Retry-After: 15, exactly what a real 429 from OpenAI looks like, and
 * the integration sets the delay. "LLM API down" throws a connection error, which has no status and is retried
 * under the retry policy's backoff.
 */
public static class ChatModel
{
    /** How long a rate-limited call waits before its retry, sent as a Retry-After header. */
    public const int RateLimitRetryAfterSeconds = 15;

    /** The chat client for a model: OpenAI with OPENAI_API_KEY, with its own retries off (Temporal retries the activity). */
    public static IChatClient OpenAi(string model)
    {
        var apiKey = Env.Get("OPENAI_API_KEY");
        if (apiKey == "") throw new InvalidOperationException("OPENAI_API_KEY is not set (see scripts/setoaikey.example)");
        var options = new OpenAIClientOptions { RetryPolicy = new ClientRetryPolicy(maxRetries: 0) };
        return new OpenAIClient(new ApiKeyCredential(apiKey), options).GetChatClient(model).AsIChatClient();
    }

    /** An OpenAI 429, as the OpenAI client reports one, with a Retry-After header. */
    public static ClientResultException RateLimited(string message) =>
        new(message, new FakeResponse(429, "Too Many Requests", ("Retry-After", RateLimitRetryAfterSeconds.ToString(System.Globalization.CultureInfo.InvariantCulture))));
}

/** Adds the chaos panel's model flags to a chat client. */
public sealed class ChaosChatClient(IChatClient inner, Chaos chaos) : DelegatingChatClient(inner)
{
    public override Task<ChatResponse> GetResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default)
    {
        Inject();
        return base.GetResponseAsync(messages, options, cancellationToken);
    }

    public override IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default)
    {
        Inject();
        return base.GetStreamingResponseAsync(messages, options, cancellationToken);
    }

    private void Inject()
    {
        chaos.Inject(Chaos.LlmDown, new HttpRequestException("Connection error: OpenAI API unavailable"));
        chaos.Inject(Chaos.LlmRateLimited, ChatModel.RateLimited("OpenAI API rate limit exceeded (HTTP 429)"));
    }
}

/** A provider response with a status and headers, for the chaos panel's 429. */
internal sealed class FakeResponse(int status, string reason, params (string Name, string Value)[] headers) : PipelineResponse
{
    private BinaryData content = BinaryData.FromString("{}");

    public override int Status => status;

    public override string ReasonPhrase => reason;

    public override Stream? ContentStream { get; set; }

    public override BinaryData Content => content;

    protected override PipelineResponseHeaders HeadersCore => new ResponseHeaders(headers);

    public override BinaryData BufferContent(CancellationToken cancellationToken = default) => content;

    public override ValueTask<BinaryData> BufferContentAsync(CancellationToken cancellationToken = default) => new(content);

    public override void Dispose()
    {
    }

    private sealed class ResponseHeaders((string Name, string Value)[] all) : PipelineResponseHeaders
    {
        public override bool TryGetValue(string name, out string? value)
        {
            value = all.FirstOrDefault(h => h.Name.Equals(name, StringComparison.OrdinalIgnoreCase)).Value;
            return value != null;
        }

        public override bool TryGetValues(string name, out IEnumerable<string>? values)
        {
            var found = all.Where(h => h.Name.Equals(name, StringComparison.OrdinalIgnoreCase)).Select(h => h.Value).ToList();
            values = found.Count > 0 ? found : null;
            return found.Count > 0;
        }

        public override IEnumerator<KeyValuePair<string, string>> GetEnumerator() =>
            all.Select(h => new KeyValuePair<string, string>(h.Name, h.Value)).GetEnumerator();
    }
}
