using System.Text.Json;
using StackExchange.Redis;

namespace WealthManagement.Common;

/**
 * The per-chat event stream the web UI polls through the API: a Redis list events:<chat workflow ID> of JSON
 * events {type, content}, a chat_interaction after each turn and a status_update for each account-opening state
 * change. The same format as the other frameworks (src/python/common/event_stream_manager.py).
 */
public interface IEventStream
{
    const string ChatInteraction = "chat_interaction";
    const string StatusUpdate = "status_update";

    /** Appends an event and returns the stream's new length. */
    long Append(string workflowId, string type, object content);

    /** Deletes a chat's stream; reports whether there was one. */
    bool Delete(string workflowId);

    static string Json(string type, object content) =>
        JsonSerializer.Serialize(new Dictionary<string, object> { ["type"] = type, ["content"] = content });
}

/** A stream stored in Redis, kept for a day after its last event. */
public sealed class RedisEventStream(IDatabase redis) : IEventStream
{
    private static readonly TimeSpan Ttl = TimeSpan.FromHours(24);

    public long Append(string workflowId, string type, object content)
    {
        var key = $"events:{workflowId}";
        var length = redis.ListRightPush(key, IEventStream.Json(type, content));
        redis.KeyExpire(key, Ttl);
        return length;
    }

    public bool Delete(string workflowId) =>
        redis.KeyDelete([$"events:{workflowId}", $"events:{workflowId}:meta"]) > 0;
}

/** A stream kept in memory, for tests. */
public sealed class InMemoryEventStream : IEventStream
{
    public Dictionary<string, List<string>> Events { get; } = [];

    public long Append(string workflowId, string type, object content)
    {
        lock (Events)
        {
            if (!Events.TryGetValue(workflowId, out var list)) Events[workflowId] = list = [];
            list.Add(IEventStream.Json(type, content));
            return list.Count;
        }
    }

    public bool Delete(string workflowId)
    {
        lock (Events) return Events.Remove(workflowId);
    }
}
