using System.Globalization;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using StackExchange.Redis;
using Temporalio.Activities;

namespace WealthManagement.Common;

/**
 * The demo's failure injection, driven by the flags in the web UI's chaos panel.
 *
 * The flags live in the Redis hash chaos:<session>:flags (field = flag name, "1" when on) and are read on every
 * activity attempt, including every model call, so a failure is switched on and off with no restart. If Redis
 * can't be reached, every flag reads as off. Each injected failure is logged to the list chaos:<session>:events
 * (the last 50) for the panel. The same keys as the other frameworks (src/python/common/chaos_manager.py). Called
 * from activities only, never from workflow code: the session comes from the running activity's workflow ID.
 */
public abstract class Chaos
{
    public const string ToolDown = "tool_down";
    public const string LlmDown = "llm_down";
    public const string LlmRateLimited = "llm_rate_limited";
    public const string CustodianRejects = "custodian_rejects";
    public const string SlowSaga = "slow_saga";
    public const string WorkflowBug = "workflow_bug";
    /** How long each saga step sleeps while SlowSaga is on. */
    public static readonly TimeSpan SlowSagaDelay = TimeSpan.FromSeconds(4);

    public abstract bool IsEnabled(string flag);

    public abstract void RecordEvent(string flag);

    /** Throws the error if the flag is on, after logging the failure for the chaos panel. */
    public void Inject(string flag, Exception error)
    {
        if (!IsEnabled(flag)) return;
        RecordEvent(flag);
        if (ActivityExecutionContext.HasCurrent)
        {
            ActivityExecutionContext.Current.Logger.LogWarning("Chaos [{Flag}]: {Message}", flag, error.Message);
        }
        throw error;
    }

    /** Fails the way the core banking API would while ToolDown is on. */
    public void CoreBankingApi() =>
        Inject(ToolDown, new InvalidOperationException("Connection error: Core banking API unavailable"));

    /** Sleeps SlowSagaDelay while SlowSaga is on, simulating a slow downstream system. */
    public async Task MaybeSlowDownAsync()
    {
        if (IsEnabled(SlowSaga)) await Task.Delay(SlowSagaDelay);
    }

    /** The running activity's type, attempt and workflow ID, for the events the chaos panel lists. */
    protected static (string Source, int Attempt, string WorkflowId) ActivityInfo()
    {
        if (!ActivityExecutionContext.HasCurrent) return ("", 0, "");
        var info = ActivityExecutionContext.Current.Info;
        return (info.ActivityType, info.Attempt, info.WorkflowId ?? "");
    }
}

/** The flags of the running activity's session, in Redis. */
public sealed class RedisChaos(IDatabase redis) : Chaos
{
    private const int MaxEvents = 50;

    public override bool IsEnabled(string flag)
    {
        try
        {
            return redis.HashGet($"chaos:{Session.Current()}:flags", flag) == "1";
        }
        catch (Exception)
        {
            // Fail open: if Redis is unreachable, chaos is off rather than breaking the demo
            return false;
        }
    }

    public override void RecordEvent(string flag)
    {
        var (source, attempt, workflowId) = ActivityInfo();
        var timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() / 1000.0;
        var json = JsonSerializer.Serialize(new Dictionary<string, object>
        {
            ["timestamp"] = Math.Round(timestamp, 3),
            ["flag"] = flag,
            ["source"] = source,
            ["attempt"] = attempt,
            ["workflow_id"] = workflowId,
        });
        var key = $"chaos:{Session.Current()}:events";
        try
        {
            redis.ListLeftPush(key, json);
            redis.ListTrim(key, 0, MaxEvents - 1);
            redis.KeyExpire(key, Session.Ttl);
        }
        catch (Exception)
        {
            // The event is only for the panel
        }
    }
}

/** Flags set in memory, for tests, with the failures it injected. */
public sealed class InMemoryChaos : Chaos
{
    private readonly HashSet<string> enabled = [];

    public List<(string Flag, string Source, string WorkflowId)> Events { get; } = [];

    public void Set(string flag, bool on)
    {
        lock (enabled)
        {
            if (on) enabled.Add(flag);
            else enabled.Remove(flag);
        }
    }

    public override bool IsEnabled(string flag)
    {
        lock (enabled) return enabled.Contains(flag);
    }

    public override void RecordEvent(string flag)
    {
        var (source, _, workflowId) = ActivityInfo();
        lock (Events) Events.Add((flag, source, workflowId));
    }

    public override string ToString() => string.Join(",", enabled.Order(StringComparer.Ordinal).Select(f => f.ToString(CultureInfo.InvariantCulture)));
}
