// Settings read from the environment, with the rules every framework shares: the browser session in a workflow
// ID, the task queues, Redis, dollar amounts and the claim check switch.
using System.Globalization;
using System.Text.RegularExpressions;
using StackExchange.Redis;
using Temporalio.Activities;

namespace WealthManagement.Common;

public static class Env
{
    /** The variable's value, trimmed, or the default when it is unset or blank. */
    public static string Get(string name, string defaultValue = "")
    {
        var value = Environment.GetEnvironmentVariable(name);
        return string.IsNullOrWhiteSpace(value) ? defaultValue : value.Trim();
    }
}

/**
 * Which browser session a chat, and everything it does, belongs to. The API starts chat workflows with IDs
 * <prefix>session-<32 hex>-chat-<16 hex>, and an open-account workflow's ID starts with its chat's ID, so every
 * activity finds the session from its workflow ID; anything else uses the "default" session. The session
 * scopes the chaos flags and, with DEMO_DATA_STORE=redis, the sample data (src/python/common/session_scope.py).
 */
public static partial class Session
{
    public const string Default = "default";
    /** How long a session's state in Redis lives after its last change. */
    public static readonly TimeSpan Ttl = TimeSpan.FromHours(24);

    [GeneratedRegex("session-([0-9a-f]{32})-chat-")]
    private static partial Regex InWorkflowId();

    /** The session in a chat's or account opening's workflow ID, or the default session. */
    public static string FromWorkflowId(string? workflowId)
    {
        var m = workflowId == null ? null : InWorkflowId().Match(workflowId);
        return m is { Success: true } ? m.Groups[1].Value : Default;
    }

    /** The running activity's workflow ID, or null outside an activity. */
    public static string? CurrentWorkflowId() =>
        ActivityExecutionContext.HasCurrent ? ActivityExecutionContext.Current.Info.WorkflowId : null;

    /** The session of the workflow whose activity is running, or the default session outside an activity. */
    public static string Current() => FromWorkflowId(CurrentWorkflowId());
}

/** This framework's task queues (src/python/common/task_queues.py). */
public static class TaskQueues
{
    /** The chat task queue when TEMPORAL_TASK_QUEUE isn't set: this framework's own. */
    public const string DefaultTaskQueue = "MAF-Supervisor";

    /** The chat workflow, the tool activities and, by default, the open-account workflow. */
    public static string Chat() => Env.Get("TEMPORAL_TASK_QUEUE", DefaultTaskQueue);

    /** The model calls, so the Temporal service can rate-limit them apart from the tools. */
    public static string Llm() => Env.Get("TEMPORAL_TASK_QUEUE_LLM", Chat() + "-llm");

    public static string OpenAccount() =>
        OpenAccount(Chat(), Environment.GetEnvironmentVariable("TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT"));

    /**
     * Unset or empty: the chat queue, so this worker runs the open-account workflow. "java":
     * <task queue>-open-account, which the Java worker started with TEMPORAL_TASK_QUEUE=<task queue> polls.
     * Anything else is the queue's name.
     */
    public static string OpenAccount(string taskQueue, string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return taskQueue;
        return value.Trim().Equals("java", StringComparison.OrdinalIgnoreCase) ? taskQueue + "-open-account" : value.Trim();
    }
}

/** Dollar amounts as the other frameworks write them: $1,234.50. */
public static class Money
{
    public static string Format(double amount) =>
        (amount < 0 ? "-$" : "$") + Math.Abs(amount).ToString("#,##0.00", CultureInfo.InvariantCulture);

    /** Rounds to cents, as balances are stored. */
    public static double Round2(double amount) => Math.Round(amount, 2, MidpointRounding.AwayFromZero);
}

/**
 * Where Redis is: REDIS_URL (redis://:<password>@<host>:<port>/<db>) when set, otherwise REDIS_HOST, REDIS_PORT
 * and the optional REDIS_PASSWORD, by default an unauthenticated Redis on localhost:6379
 * (src/python/common/redis_config.py). One connection, opened on first use and shared.
 */
public static class RedisConfig
{
    private static readonly Lazy<ConnectionMultiplexer> Shared = new(() => ConnectionMultiplexer.Connect(Options()));

    public static IDatabase Database() => Shared.Value.GetDatabase();

    public static ConfigurationOptions Options()
    {
        var url = Env.Get("REDIS_URL");
        if (url != "")
        {
            var uri = new Uri(url);
            var options = new ConfigurationOptions { EndPoints = { { uri.Host, uri.Port > 0 ? uri.Port : 6379 } } };
            var userInfo = Uri.UnescapeDataString(uri.UserInfo);
            if (userInfo != "") options.Password = userInfo.Contains(':') ? userInfo[(userInfo.IndexOf(':') + 1)..] : userInfo;
            if (uri.AbsolutePath.Trim('/') is { Length: > 0 } db) options.DefaultDatabase = int.Parse(db, CultureInfo.InvariantCulture);
            options.Ssl = uri.Scheme == "rediss";
            options.AbortOnConnectFail = false;
            return options;
        }
        var result = new ConfigurationOptions
        {
            EndPoints = { { Env.Get("REDIS_HOST", "localhost"), int.Parse(Env.Get("REDIS_PORT", "6379"), CultureInfo.InvariantCulture) } },
            AbortOnConnectFail = false,
        };
        var password = Env.Get("REDIS_PASSWORD");
        if (password != "") result.Password = password;
        return result;
    }

    /** Where Redis is, for startup messages (never the password). */
    public static string Address()
    {
        var endpoint = Options().EndPoints[0];
        return endpoint is System.Net.DnsEndPoint d ? $"{d.Host}:{d.Port}" : endpoint.ToString() ?? "";
    }
}

public static class ClaimCheckSetting
{
    /** Whether USE_CLAIM_CHECK turns the claim check on (true, t, yes, y, 1 or on, in any case). */
    public static bool Enabled(string? value = null) =>
        (value ?? Env.Get("USE_CLAIM_CHECK", "false")).Trim().ToLowerInvariant() is "true" or "t" or "yes" or "y" or "1" or "on";

    /** Whether the claim check is on, with the USE_CLAIM_CHECK value, printed at every startup. */
    public static string Status()
    {
        var value = Environment.GetEnvironmentVariable("USE_CLAIM_CHECK");
        var setting = string.IsNullOrEmpty(value) ? "USE_CLAIM_CHECK is not set" : $"USE_CLAIM_CHECK={value}";
        return Enabled() ? $"Claim check: ON ({setting}; payloads stored in Redis at {RedisConfig.Address()})" : $"Claim check: OFF ({setting})";
    }
}
