// The worker: the chat and open-account workflows and every activity on TEMPORAL_TASK_QUEUE (MAF-Supervisor by
// default), and the model calls on their own task queue (<TEMPORAL_TASK_QUEUE>-llm, or TEMPORAL_TASK_QUEUE_LLM),
// where LLM_MAX_CALLS_PER_SECOND has the Temporal service cap their rate across all workers.
//
// With TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT=java the open-account workflow runs on this framework's
// <task queue>-open-account (the Java worker in interop/open_account/java) and this worker doesn't register it.
using System.Globalization;
using System.Runtime.InteropServices;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Logging;
using Temporalio.Client;
using Temporalio.Extensions.MicrosoftAgentFramework;
using Temporalio.Worker;
using WealthManagement.Common;
using WealthManagement.Durable;

using var loggerFactory = LoggerFactory.Create(builder => builder
    .AddSimpleConsole(o =>
    {
        o.SingleLine = true;
        o.TimestampFormat = "HH:mm:ss.fff ";
    })
    .SetMinimumLevel(LogLevel.Information)
    .AddFilter("Temporalio", LogLevel.Information));

Console.Error.WriteLine(ClaimCheckSetting.Status());
var config = WorkerConfig.FromEnvironment();
// For the web UI's sidebar
WorkerInfo.PublishModel(RedisConfig.Database, config.TaskQueue, config.Model);
var ownOpenAccount = config.OpenAccountTaskQueue == config.TaskQueue;
Console.Error.WriteLine(ownOpenAccount
    ? $"Open-account workflow runs on this worker (task queue {config.TaskQueue})"
    : $"Open-account workflow runs on task queue {config.OpenAccountTaskQueue}: start the Java worker on it");
var maxCallsPerSecond = double.TryParse(Env.Get("LLM_MAX_CALLS_PER_SECOND"), NumberStyles.Float, CultureInfo.InvariantCulture, out var max) && max > 0
    ? max : (double?)null;
Console.Error.WriteLine($"Model {config.Model}; model calls run on task queue {config.LlmTaskQueue}" +
    (maxCallsPerSecond is { } m ? $", limited to {m} per second" : ""));
Console.Error.WriteLine($"Temporal {Connection.Address()}, namespace {Connection.Namespace()}, auth {Connection.Auth()}");
if (Env.Get("OPENAI_API_KEY") == "")
{
    Console.Error.WriteLine("Warning: no OPENAI_API_KEY is set (see scripts/setoaikey.example); model calls will fail and retry.");
}

var chaos = new RedisChaos(RedisConfig.Database());
var connectOptions = Connection.Options();
connectOptions.LoggerFactory = loggerFactory;
var client = await TemporalClient.ConnectAsync(connectOptions);
var activities = new WealthActivities(DataStore.FromEnvironment(), new RedisEventStream(RedisConfig.Database()), chaos, () => client, config);

// The plugin registers the model activity, which builds the OpenAI chat client on the worker from this factory
// (with the chaos panel's model flags). One instance, given to both workers, so they register the same activity.
var plugin = new MicrosoftAgentFrameworkPlugin(new MicrosoftAgentFrameworkPluginOptions
{
    ChatClients = new Dictionary<string, Func<IChatClient>>
    {
        [config.Model] = () => new ChaosChatClient(ChatModel.OpenAi(config.Model), chaos),
    },
});

var workerOptions = new TemporalWorkerOptions(config.TaskQueue) { Plugins = [plugin] }
    .AddAllActivities(activities)
    .AddWorkflow<WealthManagementWorkflow>();
if (ownOpenAccount) workerOptions.AddWorkflow<OpenInvestmentAccountWorkflow>();
var llmOptions = new TemporalWorkerOptions(config.LlmTaskQueue)
{
    Plugins = [plugin],
    MaxTaskQueueActivitiesPerSecond = maxCallsPerSecond,
};

// Stop on Ctrl-C or SIGTERM (startdemo.sh), letting the workers finish what they are doing
using var stop = new CancellationTokenSource();
using var sigint = PosixSignalRegistration.Create(PosixSignal.SIGINT, ctx => { ctx.Cancel = true; stop.Cancel(); });
using var sigterm = PosixSignalRegistration.Create(PosixSignal.SIGTERM, ctx => { ctx.Cancel = true; stop.Cancel(); });

using var worker = new TemporalWorker(client, workerOptions);
using var llmWorker = new TemporalWorker(client, llmOptions);
Console.Error.WriteLine($"Worker started on task queues {config.TaskQueue} and {config.LlmTaskQueue}");
try
{
    await Task.WhenAll(worker.ExecuteAsync(stop.Token), llmWorker.ExecuteAsync(stop.Token));
}
catch (OperationCanceledException)
{
    // Shut down
}
Console.Error.WriteLine("Worker stopped");
return 0;
