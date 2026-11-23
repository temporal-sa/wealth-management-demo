using System.ComponentModel;
using System.Text.Json;
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Logging;
using Temporalio.Exceptions;
using Temporalio.Extensions.MicrosoftAgentFramework;
using Temporalio.Workflows;
using WealthManagement.Common;

namespace WealthManagement.Durable;

/**
 * WealthManagementWorkflow: one chat. It runs the Microsoft Agent Framework agents inside the workflow, one
 * customer message at a time, with Temporal's Microsoft Agent Framework integration
 * (Temporalio.Extensions.MicrosoftAgentFramework): every agent is a TemporalAgent, so every model call is an
 * activity on the model task queue, and every tool that touches the outside world runs an activity. The agent
 * loops and the conversation (each agent's session) live in the workflow, so a turn interrupted by a worker crash
 * or an outage resumes where it stopped.
 *
 * The agents are "agents as tools", as in the Strands frameworks: the supervisor delegates to a beneficiary agent
 * and an investment agent, each called as a tool, and the investment agent delegates account openings to a
 * dedicated open-account agent, which starts an OpenInvestmentAccountWorkflow child for every request to open an
 * account. The specialized agents keep their session for the whole chat, so they remember what they asked.
 *
 * Deleting a beneficiary and closing an account use the integration's approvals: the tool is an
 * ApprovalRequiredAIFunction, so the agent's run stops with an approval request instead of calling it, the
 * supervisor asks the customer, and the customer's answer in their next message approves or rejects the call.
 */
[Workflow(Names.WealthManagementWorkflow)]
public class WealthManagementWorkflow
{
    public const string ErrorResponse = "Sorry, something went wrong while handling your request. Please try again.";
    public const string EmptyResponse = "Sorry, I didn't catch that. Could you please say it again?";
    public static readonly TimeSpan ChatIdleTimeout = TimeSpan.FromHours(1);

    public const string KycNotApproved =
        "KYC was not approved. First show the customer their current details for this account opening " +
        "(get_current_client_info) and ask whether they are correct. Approve KYC only after the customer " +
        "confirms in their next message.";

    private static readonly ActivityOptions Tool = new()
    {
        StartToCloseTimeout = RetryPolicies.ToolTimeout,
        RetryPolicy = RetryPolicies.Tool,
    };

    private readonly Queue<string> pendingMessages = new();
    private readonly Queue<string> pendingStatuses = new();
    private readonly List<ChatInteraction> chatHistory = [];
    private bool endWorkflow;

    // Everything the agents need to remember between turns is workflow state, so it is deterministic and
    // survives replay.
    private int turn;
    // Latest state and account name reported by each open-account child workflow, keyed by its workflow ID
    private readonly Dictionary<string, string> accountOpeningStates = [];
    private readonly Dictionary<string, string> accountOpeningNames = [];
    // Number of account openings started in this chat. The next one's workflow ID ends with this plus one.
    private int accountOpeningsStarted;
    // The customer turn in which each account opening's details were shown (the KYC guard)
    private readonly Dictionary<string, int> kycDetailsShownTurn = [];
    // The approval requests each specialized agent is waiting on, and the turn in which the customer was asked
    private readonly Dictionary<string, (List<ToolApprovalRequestContent> Requests, int Turn)> pendingApprovals = [];
    // What this turn's agents did, for the chat history: handoffs and tool calls, and the tools' results
    private readonly List<string> trace = [];
    private readonly List<string> toolOutputs = [];

    private WorkerConfig config = null!;

    [WorkflowSignal(Names.ProcessUserMessageSignal)]
    public Task ProcessUserMessageAsync(ProcessUserMessageInput input)
    {
        Workflow.Logger.LogInformation("Received user message: {Message}", input.UserInput);
        pendingMessages.Enqueue(input.UserInput);
        return Task.CompletedTask;
    }

    [WorkflowSignal(Names.EndWorkflowSignal)]
    public Task EndWorkflowAsync()
    {
        endWorkflow = true;
        return Task.CompletedTask;
    }

    // Recorded at once, even in the middle of a turn, so the next status check is up to date
    [WorkflowSignal(Names.UpdateAccountOpeningStateSignal)]
    public Task UpdateAccountOpeningStateAsync(UpdateAccountOpeningStateInput update)
    {
        if (update.WorkflowId is { } id) accountOpeningStates[id] = update.State;
        pendingStatuses.Enqueue(States.StatusText(update.AccountName, update.State));
        return Task.CompletedTask;
    }

    [WorkflowQuery(Names.GetChatHistoryQuery)]
    public List<ChatInteraction> GetChatHistory() => chatHistory;

    [WorkflowQuery(Names.GetAccountOpeningStatesQuery)]
    public Dictionary<string, string> GetAccountOpeningStates() => accountOpeningStates;

    /** Whether an account opening's details were shown in an earlier customer message (the KYC guard). */
    public static bool KycConfirmed(int? shownTurn, int turn) => shownTurn is { } shown && shown < turn;

    /** Whether the customer answered a confirmation question in the message right after it was asked. */
    public static bool AnsweredInTime(int askedTurn, int turn) => askedTurn == turn - 1;

    /** The open-account workflow ID: OpenAccount-<chat workflow ID>-<client ID>-<account name as given>-<n>. */
    public static string OpenAccountWorkflowId(string chatWorkflowId, string clientId, string accountName, int n) =>
        $"OpenAccount-{chatWorkflowId}-{clientId}-{accountName}-{n}";

    [WorkflowRun]
    public async Task RunAsync()
    {
        var workflowId = Workflow.Info.WorkflowId;
        config = await Workflow.ExecuteLocalActivityAsync(
            (WealthActivities a) => a.GetWorkerConfig(), new LocalActivityOptions { StartToCloseTimeout = TimeSpan.FromSeconds(10) });

        // The UI reuses chat workflow IDs, so drop any earlier conversation stored under this one.
        await Workflow.ExecuteActivityAsync((WealthActivities a) => a.DeleteConversation(workflowId), Tool);

        var supervisor = await BuildAgentsAsync();

        while (true)
        {
            var woken = await Workflow.WaitConditionAsync(
                () => pendingMessages.Count > 0 || pendingStatuses.Count > 0 || endWorkflow, ChatIdleTimeout);
            if (!woken)
            {
                // Nobody has used this chat for a while (e.g. the tab was closed without End Chat)
                Workflow.Logger.LogInformation("Ending chat: idle for {Timeout}", ChatIdleTimeout);
                return;
            }
            if (endWorkflow)
            {
                Workflow.Logger.LogInformation("Ending chat");
                return;
            }
            if (pendingMessages.TryDequeue(out var message))
            {
                await ProcessChatMessageAsync(supervisor, message);
            }
            if (pendingStatuses.TryDequeue(out var status))
            {
                await Workflow.ExecuteActivityAsync((WealthActivities a) => a.AppendStatusUpdate(workflowId, new StatusUpdate(status)), Tool);
            }

            // TODO: Continue-As-New. This demo keeps the whole conversation in one run. A production system would
            // continue-as-new when Workflow.ContinueAsNewSuggested is true: wait for Workflow.AllHandlersFinished,
            // drain the queues, and carry each agent's session (agent.SerializeSessionAsync), the account-opening
            // states, the turn counters, the KYC guard and any pending approvals into the new run, minding that the
            // open-account children use ParentClosePolicy.Terminate, which also applies on continue-as-new.
        }
    }

    private sealed record Agent(TemporalAgent Value, AgentSession Session, string Name);

    private Agent supervisorAgent = null!;

    private async Task ProcessChatMessageAsync(Agent supervisor, string message)
    {
        turn += 1;
        trace.Clear();
        toolOutputs.Clear();
        string text;
        try
        {
            var response = await supervisor.Value.RunAsync(message, supervisor.Session);
            text = Reply(response);
            if (text == "") text = EmptyResponse;
        }
        catch (FailureException e)
        {
            // A turn that can't finish (a model call failing for good, say) must not end the chat
            Workflow.Logger.LogError("Agent turn failed: {Error}", e.Message);
            trace.Add($"error: {e.Message}");
            text = ErrorResponse;
        }
        var interaction = new ChatInteraction(
            message, text,
            string.Concat(toolOutputs.Select(o => o + "\n")),
            string.Concat(trace.Select(t => t + "\n")));
        chatHistory.Add(interaction);
        var workflowId = Workflow.Info.WorkflowId;
        await Workflow.ExecuteActivityAsync((WealthActivities a) => a.AppendChatInteraction(workflowId, interaction), Tool);
    }

    /** The agent's answer: the text of its messages, one paragraph each. */
    private static string Reply(AgentResponse response) => string.Join("\n\n",
        response.Messages.Where(m => m.Role == ChatRole.Assistant && !string.IsNullOrWhiteSpace(m.Text)).Select(m => m.Text.Trim()));

    // -------------------------------------------------------------------------
    // Agents
    // -------------------------------------------------------------------------

    /** A TemporalAgent and its session: every model call is the integration's model activity, retried until the model answers. */
    private async Task<Agent> NewAgentAsync(string name, string instructions, IList<AITool> tools)
    {
        var agent = new TemporalAgent(config.Model, new TemporalAgentOptions
        {
            Name = name,
            ChatOptions = new ChatOptions { Instructions = instructions, Tools = tools },
            ModelActivityOptions = new ActivityOptions
            {
                TaskQueue = config.LlmTaskQueue,
                StartToCloseTimeout = RetryPolicies.ModelTimeout,
                RetryPolicy = RetryPolicies.Llm,
            },
        });
        return new Agent(agent, await agent.CreateSessionAsync(), name);
    }

    private async Task<Agent> BuildAgentsAsync()
    {
        var beneficiary = await NewAgentAsync(Prompts.BeneficiaryAgentName, Prompts.BeneficiaryInstructions, BeneficiaryTools(Prompts.BeneficiaryAgentName));
        var openAccount = await NewAgentAsync(Prompts.OpenAccountAgentName, Prompts.OpenAccountInstructions, OpenAccountTools(Prompts.OpenAccountAgentName));
        var investment = await NewAgentAsync(Prompts.InvestmentAgentName, Prompts.TemporalInvestmentInstructions,
            [.. InvestmentTools(Prompts.InvestmentAgentName), OpenAccountAssistant(openAccount)]);
        supervisorAgent = await NewAgentAsync(Prompts.SupervisorAgentName, Prompts.TemporalSupervisorInstructions,
            [Assistant(beneficiary, "beneficiary_assistant", "Handle a beneficiary request (list, add, or delete beneficiaries)."),
             Assistant(investment, "investment_assistant",
                "Handle any investment-account request: list, close, or open an account (opening is delegated onward to the open-account agent).")]);
        return supervisorAgent;
    }

    /** A tool that records its call in the trace and its result in the chat history. */
    private AIFunction Recorded(string agentName, AIFunction function) =>
        new RecordedFunction(function, () => trace.Add($"{agentName}: Calling a tool: {function.Name}"), result => toolOutputs.Add(result));

    private static AIFunction Function(Delegate method, string name, string description) =>
        AIFunctionFactory.Create(method, name, description);

    /**
     * A specialized agent called as a tool. A confirmation the agent asked for is answered first: approved when the
     * customer said yes in the message right after the question, rejected otherwise.
     */
    private AIFunction Assistant(Agent target, string name, string description) => Function(
        async ([Description("The customer's client ID")] string client_id,
               [Description("What the customer wants done, in their words")] string request,
               [Description("Only when the customer was asked to confirm a delete or close in the previous message: true if they said yes, false if they said no")] bool? confirmed = null) =>
        {
            trace.Add($"Handed off from {Prompts.SupervisorAgentName} to {target.Name}");
            return await RunSpecializedAsync(target, Request(client_id, request), confirmed);
        },
        name, description);

    private static string Request(string clientId, string text) => $"The client ID is {clientId}. {text}";

    /**
     * Added to a request whose yes or no answers nothing this agent asked (the supervisor set confirmed anyway, say
     * for a KYC "yes"): the request still goes through, but the agent mustn't claim a delete or close it didn't do.
     */
    public const string NothingToConfirm =
        "(Nothing is waiting for the customer's confirmation here: don't say anything was deleted or closed unless a tool you call now says so.)";

    private async Task<string> RunSpecializedAsync(Agent target, string request, bool? confirmed = null)
    {
        if (confirmed != null && !pendingApprovals.ContainsKey(target.Name))
        {
            trace.Add($"{target.Name}: Nothing was waiting for the customer's confirmation");
            request = $"{request} {NothingToConfirm}";
            confirmed = null;
        }
        var messages = new List<ChatMessage>();
        if (pendingApprovals.Remove(target.Name, out var pending))
        {
            var approved = confirmed == true && AnsweredInTime(pending.Turn, turn);
            var reason = approved ? null : confirmed == false
                ? "The customer said no."
                : "The customer did not confirm it in the message right after the question.";
            foreach (var r in pending.Requests)
            {
                trace.Add($"{target.Name}: The customer {(approved ? "confirmed" : "did not confirm")} {ToolName(r)}");
            }
            messages.Add(new ChatMessage(ChatRole.User, [.. pending.Requests.Select(r => (AIContent)r.CreateResponse(approved, reason))]));
        }
        // A yes or no is the whole answer: the agent reports the call's result (or that it didn't run). Anything
        // else is a new request, after the unanswered confirmation was rejected.
        if (confirmed == null || messages.Count == 0) messages.Add(new ChatMessage(ChatRole.User, request));
        var response = await target.Value.RunAsync(messages, target.Session);
        var requests = response.Messages.SelectMany(m => m.Contents).OfType<ToolApprovalRequestContent>().ToList();
        if (requests.Count == 0) return Reply(response);
        pendingApprovals[target.Name] = (requests, turn);
        foreach (var r in requests) trace.Add($"{target.Name}: Asking the customer to confirm {ToolName(r)}");
        return ConfirmationNeeded(requests);
    }

    /** What the supervisor is told when a call waits for the customer's confirmation. */
    public static string ConfirmationNeeded(IEnumerable<ToolApprovalRequestContent> requests)
    {
        var questions = requests.Select(r => r.ToolCall switch
        {
            FunctionCallContent { Name: "delete_beneficiary" } c =>
                $"\"Are you sure you want to delete beneficiary <first and last name>?\" (beneficiary ID {Argument(c, "beneficiary_id")})",
            FunctionCallContent { Name: "close_investment" } c =>
                $"\"Are you sure you want to close your <account name> account?\" (investment ID {Argument(c, "investment_id")})",
            var c => $"whether to go ahead with {(c as FunctionCallContent)?.Name}",
        });
        return "Not done yet: this needs the customer's confirmation. Ask the customer " + string.Join(" and ", questions) +
            ", naming it from the list shown earlier, and stop. In the customer's next message, call the same tool again " +
            "with their answer as the request and confirmed set to true if they said yes, or false if they said no.";
    }

    private static string ToolName(ToolApprovalRequestContent request) => (request.ToolCall as FunctionCallContent)?.Name ?? "a tool";

    private static string Argument(FunctionCallContent call, string name) =>
        call.Arguments?.TryGetValue(name, out var v) == true ? v?.ToString() ?? "" : "";

    // -------------------------------------------------------------------------
    // Tools. They run in workflow code: anything that does I/O runs an activity.
    // -------------------------------------------------------------------------

    private IList<AITool> BeneficiaryTools(string agent) =>
    [
        Recorded(agent, Function(
            async ([Description("The customer's client ID")] string client_id) =>
                await Workflow.ExecuteActivityAsync((WealthActivities a) => a.ListBeneficiaries(client_id), Tool),
            "list_beneficiaries", "List a client's beneficiaries.")),
        Recorded(agent, Function(
            async ([Description("The customer's client ID")] string client_id, string first_name, string last_name,
                   [Description("The beneficiary's relationship to the customer, such as son or spouse")] string relationship) =>
            {
                await Workflow.ExecuteActivityAsync(
                    (WealthActivities a) => a.AddBeneficiary(new NewBeneficiary(client_id, first_name, last_name, relationship)), Tool);
                return $"Beneficiary {first_name} {last_name} added.";
            },
            "add_beneficiary", "Add a new beneficiary for a client.")),
        new ApprovalRequiredAIFunction(Recorded(agent, Function(
            async ([Description("The customer's client ID")] string client_id, string beneficiary_id) =>
            {
                await Workflow.ExecuteActivityAsync((WealthActivities a) => a.DeleteBeneficiary(client_id, beneficiary_id), Tool);
                return "Beneficiary deleted.";
            },
            "delete_beneficiary", "Delete a client's beneficiary by its beneficiary ID. The customer is asked to confirm before it runs."))),
    ];

    private IList<AITool> InvestmentTools(string agent) =>
    [
        Recorded(agent, Function(
            async ([Description("The customer's client ID")] string client_id) =>
                await Workflow.ExecuteActivityAsync((WealthActivities a) => a.ListInvestments(client_id), Tool),
            "list_investments", "List a client's investment accounts and their balances.")),
        new ApprovalRequiredAIFunction(Recorded(agent, Function(
            async ([Description("The customer's client ID")] string client_id, string investment_id) =>
            {
                await Workflow.ExecuteActivityAsync((WealthActivities a) => a.CloseInvestment(client_id, investment_id), Tool);
                return "Investment account closed.";
            },
            "close_investment", "Close a client's investment account by its investment ID. The customer is asked to confirm before it runs."))),
    ];

    private AIFunction OpenAccountAssistant(Agent openAccount) => Function(
        async ([Description("The customer's client ID")] string client_id,
               [Description("What the customer wants done, in their words")] string request) =>
        {
            trace.Add($"Handed off from {Prompts.InvestmentAgentName} to {Prompts.OpenAccountAgentName}");
            // Its history holds whatever status it last saw, so give it the current status on every turn
            return await RunSpecializedAsync(openAccount, Request(client_id, AccountOpeningsSummary() + request));
        },
        "open_account_assistant",
        "Open a new investment account (a multi-step, durable KYC + compliance flow). This delegates to a persistent " +
        "open-account agent: relay whatever the customer said and relay its reply back.");

    private IList<AITool> OpenAccountTools(string agent) =>
    [
        Recorded(agent, Function(
            async ([Description("The customer's client ID")] string client_id,
                   [Description("The name for the new investment account")] string account_name,
                   [Description("The initial deposit amount")] double initial_amount) =>
                await OpenNewInvestmentAccountAsync(client_id, account_name, initial_amount),
            "open_new_investment_account",
            "Begin opening a new investment account via a durable child workflow. Returns the workflow ID, which the other " +
            "open-account tools require, or the reason the account cannot be opened. Starting the opening does not open " +
            "the account: it still needs KYC and a compliance review.")),
        Recorded(agent, Function(
            ([Description("The workflow ID returned by open_new_investment_account")] string workflow_id) =>
                accountOpeningStates.TryGetValue(workflow_id, out var s)
                    ? s : $"No account opening with workflow ID {workflow_id} was found in this conversation.",
            "get_account_opening_status",
            "Get the current status of an account opening. \"Complete\" means the account was opened; a status starting " +
            "with \"Rolled back\" means it was not opened. Either way, that account opening is finished.")),
        Recorded(agent, Function(
            async ([Description("The workflow ID returned by open_new_investment_account")] string workflow_id) =>
            {
                var details = await Workflow.ExecuteActivityAsync((WealthActivities a) => a.GetCurrentClientInfo(workflow_id), Tool);
                kycDetailsShownTurn[workflow_id] = turn;
                return details;
            },
            "get_current_client_info", "Retrieve the customer's current details for an account opening, to show them for KYC.")),
        Recorded(agent, Function(
            async ([Description("The workflow ID returned by open_new_investment_account")] string workflow_id) =>
            {
                // The model sometimes treats a confirmation for an earlier opening as approval for a new one, or
                // approves in the same turn it shows the details: approve only once this opening's details were
                // shown and the customer has replied since.
                if (!KycConfirmed(kycDetailsShownTurn.TryGetValue(workflow_id, out var t) ? t : null, turn)) return KycNotApproved;
                await Workflow.ExecuteActivityAsync((WealthActivities a) => a.ApproveKyc(workflow_id), Tool);
                return "KYC approved. The account is now waiting for compliance review.";
            },
            "approve_kyc", "Approve KYC for an account opening, after the customer confirmed their details are correct.")),
        Recorded(agent, Function(
            async ([Description("The workflow ID returned by open_new_investment_account")] string workflow_id,
                   string? first_name = null, string? last_name = null, string? address = null,
                   string? phone = null, string? email = null, string? marital_status = null) =>
            {
                var fields = new Dictionary<string, string?>
                {
                    ["first_name"] = first_name, ["last_name"] = last_name, ["address"] = address,
                    ["phone"] = phone, ["email"] = email, ["marital_status"] = marital_status,
                };
                var changed = WealthActivities.Changed(fields).ToDictionary(f => f.Key, f => (string?)f.Value);
                return await Workflow.ExecuteActivityAsync((WealthActivities a) => a.UpdateClientDetails(workflow_id, changed), Tool);
            },
            "update_client_details",
            "Update one or more of the customer's details during an account opening (this also completes KYC). Set only " +
            "the fields that change.")),
    ];

    /** Validates the request, then starts an open-account child workflow with the next opening number. */
    private async Task<string> OpenNewInvestmentAccountAsync(string clientId, string accountName, double initialAmount)
    {
        // Business rules first. A broken rule fails on the first attempt and the reason goes back to the agent.
        try
        {
            await Workflow.ExecuteActivityAsync((WealthActivities a) => a.ValidateNewAccount(clientId, accountName, initialAmount), Tool);
        }
        catch (ActivityFailureException e) when (e.InnerException is ApplicationFailureException { NonRetryable: true } reason)
        {
            return $"The account cannot be opened: {reason.Message}";
        }
        // Read in an activity, so it is recorded in history and replays the same
        var promoCode = await Workflow.ExecuteActivityAsync((WealthActivities a) => a.FindPromotion(clientId), Tool);
        var n = accountOpeningsStarted + 1;
        var childId = OpenAccountWorkflowId(Workflow.Info.WorkflowId, clientId, accountName, n);
        await Workflow.StartChildWorkflowAsync(
            (OpenInvestmentAccountWorkflow wf) => wf.RunAsync(new OpenInvestmentAccountInput(clientId, accountName, initialAmount, promoCode)),
            new ChildWorkflowOptions
            {
                Id = childId,
                TaskQueue = config.OpenAccountTaskQueue,
                ParentClosePolicy = ParentClosePolicy.Terminate,
            });
        accountOpeningsStarted = n;
        // Known from the start, so a status check right away doesn't report "not found"
        accountOpeningStates.TryAdd(childId, States.Initializing);
        accountOpeningNames.TryAdd(childId, accountName);
        // A bare ID reads like success, and models have told customers their account was open: say it isn't.
        return "Account opening started. The account is NOT open yet: the customer must confirm their details (KYC), " +
            $"then it needs a compliance review. Workflow ID: {childId}";
    }

    /** The current status of each account opening, to put before a request to the open-account agent. */
    private string AccountOpeningsSummary()
    {
        if (accountOpeningStates.Count == 0) return "";
        var openings = accountOpeningStates.Select(kv =>
            $"{accountOpeningNames.GetValueOrDefault(kv.Key, kv.Key)} (workflow ID {kv.Key}): \"{kv.Value}\"");
        return $"Current status of account openings in this conversation: {string.Join("; ", openings)}. ";
    }
}

/** A tool that tells the workflow when it runs and what it returned, for the trace and the chat history. */
internal sealed class RecordedFunction(AIFunction inner, Action called, Action<string> result) : DelegatingAIFunction(inner)
{
    protected override async ValueTask<object?> InvokeCoreAsync(AIFunctionArguments arguments, CancellationToken cancellationToken)
    {
        called();
        var value = await base.InvokeCoreAsync(arguments, cancellationToken);
        result(value switch
        {
            null => "",
            string s => s,
            JsonElement e => e.ValueKind == JsonValueKind.String ? e.GetString()! : e.GetRawText(),
            _ => JsonSerializer.Serialize(value),
        });
        return value;
    }
}
