// Test helpers: the SDK's local test server, workers over a fresh copy of the demo data with an in-memory event
// stream and chaos flags, and a scripted chat client in place of OpenAI, so the suite needs no model key, no Redis
// and no running Temporal service.
using System.Text.Json;
using Microsoft.Extensions.AI;
using Temporalio.Activities;
using Temporalio.Client;
using Temporalio.Extensions.MicrosoftAgentFramework;
using Temporalio.Testing;
using Temporalio.Worker;
using WealthManagement.Common;
using WealthManagement.Durable;

namespace WealthManagement.Tests;

/** Which agent a request came from, told apart by the tools it was offered. */
public enum AgentKind { Supervisor, Beneficiary, Investment, OpenAccount, Unknown }

/** What the scripted model sees of a request. */
public sealed record ScriptedRequest(
    AgentKind Agent,
    string Instructions,
    List<string> Tools,
    string LastUserText,
    List<string> ResultsThisTurn,
    List<string> AllResults);

public abstract record Step;
public sealed record Say(string Text) : Step;
public sealed record Call(string Name, Dictionary<string, object?> Args) : Step;

/** Where a model call ran: the activity's task queue and workflow ID. */
public sealed record ModelCall(AgentKind Agent, string TaskQueue, string? WorkflowId);

/** A chat client that answers from a script. Every request it got is kept. */
public sealed class ScriptedChatClient : IChatClient
{
    private static int callCounter;
    public static List<ScriptedRequest> Requests { get; } = [];
    public static List<ModelCall> Calls { get; } = [];
    public static Func<ScriptedRequest, Step> Script { get; set; } = _ => new Say("Hello");

    public static void Reset(Func<ScriptedRequest, Step> script)
    {
        lock (Requests)
        {
            Requests.Clear();
            Calls.Clear();
            Script = script;
        }
    }

    public static ScriptedRequest ToRequest(IEnumerable<ChatMessage> messages, ChatOptions? options)
    {
        var tools = (options?.Tools ?? []).Select(t => t.Name).ToList();
        var list = messages.ToList();
        var lastUser = list.FindLastIndex(m => m.Role == ChatRole.User && m.Contents.OfType<TextContent>().Any());
        List<string> Results(int from) => list.Skip(from)
            .SelectMany(m => m.Contents.OfType<FunctionResultContent>())
            .Select(r => r.Result switch { null => "", string s => s, JsonElement e when e.ValueKind == JsonValueKind.String => e.GetString()!, JsonElement e => e.GetRawText(), var o => JsonSerializer.Serialize(o) })
            .ToList();
        var agent = tools.Contains("beneficiary_assistant") ? AgentKind.Supervisor
            : tools.Contains("list_beneficiaries") ? AgentKind.Beneficiary
            : tools.Contains("open_account_assistant") ? AgentKind.Investment
            : tools.Contains("open_new_investment_account") ? AgentKind.OpenAccount
            : AgentKind.Unknown;
        return new ScriptedRequest(agent, options?.Instructions ?? "", tools,
            lastUser >= 0 ? list[lastUser].Text : "", Results(lastUser + 1), Results(0));
    }

    public Task<ChatResponse> GetResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default)
    {
        var request = ToRequest(messages, options);
        Step step;
        lock (Requests)
        {
            Requests.Add(request);
            var info = ActivityExecutionContext.Current.Info;
            Calls.Add(new ModelCall(request.Agent, info.TaskQueue, info.WorkflowId));
            step = Script(request);
        }
        var message = step switch
        {
            Say say => new ChatMessage(ChatRole.Assistant, say.Text),
            Call call => new ChatMessage(ChatRole.Assistant,
                [new FunctionCallContent($"call-{Interlocked.Increment(ref callCounter)}", call.Name, call.Args)]),
            _ => throw new InvalidOperationException(),
        };
        return Task.FromResult(new ChatResponse(message) { FinishReason = step is Call ? ChatFinishReason.ToolCalls : ChatFinishReason.Stop });
    }

    public IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default) =>
        throw new NotSupportedException("The scripted model does not stream");

    public object? GetService(Type serviceType, object? serviceKey = null) => null;

    public void Dispose()
    {
    }
}

/** The SDK's local test server, shared by the tests of a class. */
public sealed class TemporalFixture : IAsyncLifetime
{
    public WorkflowEnvironment Env { get; private set; } = null!;

    public async Task InitializeAsync() => Env = await WorkflowEnvironment.StartLocalAsync();

    public async Task DisposeAsync() => await Env.ShutdownAsync();
}

[CollectionDefinition("temporal")]
public sealed class TemporalCollection : ICollectionFixture<TemporalFixture>;

/**
 * Two workers like the real one: the chat workflow, the open-account workflow and the activities on one task
 * queue, and the model calls on a <queue>-llm queue of their own, over a fresh copy of the demo data. The model is
 * the scripted one, with the chaos panel's model flags.
 */
public sealed class TestWorker
{
    public const string Model = "scripted-model";
    private static int queueCounter;

    public required ITemporalClient Client { get; init; }
    public required string TaskQueue { get; init; }
    public required string LlmTaskQueue { get; init; }
    public required DataStore Store { get; init; }
    public required InMemoryEventStream Events { get; init; }
    public required Chaos Chaos { get; init; }
    public required TemporalWorkerOptions Options { get; init; }
    public required TemporalWorkerOptions LlmOptions { get; init; }

    public static TestWorker Create(WorkflowEnvironment env, Chaos? chaos = null)
    {
        var taskQueue = $"test-{Environment.ProcessId}-{Interlocked.Increment(ref queueCounter)}";
        var llm = taskQueue + "-llm";
        var store = new DataStore(FreshDataDir());
        var events = new InMemoryEventStream();
        chaos ??= new InMemoryChaos();
        var config = new WorkerConfig(taskQueue, taskQueue, llm, Model);
        var activities = new WealthActivities(store, events, chaos, () => env.Client, config);
        var plugin = new MicrosoftAgentFrameworkPlugin(new MicrosoftAgentFrameworkPluginOptions
        {
            ChatClients = new Dictionary<string, Func<IChatClient>> { [Model] = () => new ChaosChatClient(new ScriptedChatClient(), chaos) },
        });
        return new TestWorker
        {
            Client = env.Client,
            TaskQueue = taskQueue,
            LlmTaskQueue = llm,
            Store = store,
            Events = events,
            Chaos = chaos,
            Options = new TemporalWorkerOptions(taskQueue) { Plugins = [plugin] }
                .AddAllActivities(activities)
                .AddWorkflow<WealthManagementWorkflow>()
                .AddWorkflow<OpenInvestmentAccountWorkflow>(),
            LlmOptions = new TemporalWorkerOptions(llm) { Plugins = [plugin] },
        };
    }

    /** Runs the test while both workers poll, and shuts them down after. */
    public async Task RunAsync(Func<Task> test)
    {
        using var worker = new TemporalWorker(Client, Options);
        using var llmWorker = new TemporalWorker(Client, LlmOptions);
        await worker.ExecuteAsync(() => llmWorker.ExecuteAsync(test));
    }

    /** A fresh copy of the committed demo data (never data/ itself, which a demo run changes). */
    public static string FreshDataDir()
    {
        var dir = Directory.CreateTempSubdirectory("wm-data-").FullName;
        foreach (var f in Directory.GetFiles(Path.Combine(AppContext.BaseDirectory, "fixtures", "data")))
        {
            File.Copy(f, Path.Combine(dir, Path.GetFileName(f)));
        }
        return dir;
    }

    public Task<WorkflowHandle<WealthManagementWorkflow>> StartChatAsync(string name, string? workflowId = null) =>
        Client.StartWorkflowAsync((WealthManagementWorkflow wf) => wf.RunAsync(),
            new WorkflowOptions(workflowId ?? $"{name}-{Guid.NewGuid():N}", TaskQueue));
}

public static class Wait
{
    /** Polls until the function returns a value, or fails after the timeout. */
    public static async Task<T> ForAsync<T>(Func<Task<T?>> fn, string what, int timeoutMs = 30_000) where T : class
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (true)
        {
            if (await fn() is { } v) return v;
            if (DateTime.UtcNow > deadline) throw new TimeoutException($"Timed out waiting for {what}");
            await Task.Delay(100);
        }
    }

    /** Sends a customer message and waits for its reply. */
    public static async Task<ChatInteraction> SendAsync(WorkflowHandle<WealthManagementWorkflow> handle, string text, int timeoutMs = 60_000)
    {
        var before = (await handle.QueryAsync(wf => wf.GetChatHistory())).Count;
        await handle.SignalAsync(wf => wf.ProcessUserMessageAsync(new ProcessUserMessageInput(text)));
        return await ForAsync(async () =>
        {
            var history = await handle.QueryAsync(wf => wf.GetChatHistory());
            return history.Count > before ? history[before] : null;
        }, $"the reply to \"{text}\"", timeoutMs);
    }

    public static Task<Dictionary<string, string>> OpeningStatesAsync(WorkflowHandle<WealthManagementWorkflow> handle) =>
        handle.QueryAsync(wf => wf.GetAccountOpeningStates());
}
