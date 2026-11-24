using System.Text.Json;
using StackExchange.Redis;

namespace WealthManagement.Common;

/**
 * Records which model this worker uses, for the web UI's sidebar: the same Redis hash the Python workers write
 * (src/python/common/worker_info.py). Key WorkerInfo.Key, field the chat task queue, value JSON {"model": ...}. The
 * API reads it for the frameworks whose workers are polling.
 */
public static class WorkerInfo
{
    /** The Redis hash of every worker's model, by chat task queue. */
    public const string Key = "worker-info";

    /** The hash value for a model: JSON {"model": ...}. */
    public static string Value(string model) => JsonSerializer.Serialize(new Dictionary<string, string> { ["model"] = model });

    /** Records this worker's model. A Redis failure is reported and ignored: the worker runs without it. */
    public static void PublishModel(Func<IDatabase> redis, string taskQueue, string model)
    {
        try
        {
            redis().HashSet(Key, taskQueue, Value(model));
        }
        catch (Exception e) when (e is RedisException or TimeoutException or InvalidOperationException)
        {
            Console.Error.WriteLine($"Couldn't record the model in Redis, so the web UI won't show it: {e.Message}");
        }
    }
}
