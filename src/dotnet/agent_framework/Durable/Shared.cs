// The shared Temporal contract: workflow, signal, query, update and activity names, the open-account states and
// the business failure types. They match every other framework exactly (snake_case), so the scripts, the API, the
// web UI and the Java open-account worker work with this one.
using System.Text.Json.Serialization;
using Temporalio.Common;

namespace WealthManagement.Durable;

public static class Names
{
    public const string WealthManagementWorkflow = "WealthManagementWorkflow";
    public const string OpenInvestmentAccountWorkflow = "OpenInvestmentAccountWorkflow";

    // WealthManagementWorkflow
    public const string ProcessUserMessageSignal = "process_user_message";
    public const string EndWorkflowSignal = "end_workflow";
    public const string UpdateAccountOpeningStateSignal = "update_account_opening_state";
    public const string GetChatHistoryQuery = "get_chat_history";
    /** Not part of the shared contract: the latest state of each account opening, for the tests. */
    public const string GetAccountOpeningStatesQuery = "get_account_opening_states";

    // OpenInvestmentAccountWorkflow
    public const string GetCurrentStateQuery = "get_current_state";
    public const string GetClientDetailsUpdate = "get_client_details";
    public const string UpdateClientDetailsUpdate = "update_client_details";
    public const string VerifyKycSignal = "verify_kyc";
    public const string ComplianceApprovedSignal = "compliance_approved";
}

public static class States
{
    public const string Initializing = "Initializing";
    public const string WaitingKyc = "Waiting KYC";
    public const string WaitingCompliance = "Waiting Compliance Review";
    public const string ComplianceApproved = "Compliance review has been approved. Creating Investment Account";
    public const string CreatingRecord = "Creating the account record.";
    public const string Registering = "Registering the account with the custodian.";
    public const string Complete = "Complete";

    /** The status text shown in the web UI when an account opening changes state. */
    public static string StatusText(string accountName, string state) => $"New {accountName} account status changed: {state}";
}

/** Business failures: non-retryable ApplicationFailure types, and the deposit rules. */
public static class BusinessRules
{
    public const string DepositBelowMinimum = "DepositBelowMinimum";
    public const string DepositLimitExceeded = "DepositLimitExceeded";
    public const string InsufficientFunds = "InsufficientFunds";
    public const string CustodianRejected = "CustodianRejected";
    public const double MinInitialDeposit = 100;
    public const double MaxInitialDeposit = 1_000_000;
    public const string WelcomeBonusPromoCode = "WELCOME-BONUS";
}

/**
 * The retry policies, the same as the other frameworks'. Both retry with no attempt limit: an outage pauses the
 * agent instead of failing the conversation, and it carries on as soon as the dependency recovers. Business
 * failures, raised as non-retryable, still fail at once. Pair them with a start-to-close timeout (one attempt),
 * never schedule-to-close (all attempts), or an outage times out instead of being waited out.
 */
public static class RetryPolicies
{
    /** Tool and business-system activities. */
    public static readonly RetryPolicy Tool = new()
    {
        InitialInterval = TimeSpan.FromSeconds(1),
        BackoffCoefficient = 2,
        MaximumInterval = TimeSpan.FromSeconds(5),
    };

    /** Model calls. A rate-limited call overrides this backoff with its Retry-After delay. */
    public static readonly RetryPolicy Llm = new()
    {
        InitialInterval = TimeSpan.FromSeconds(1),
        BackoffCoefficient = 2,
        MaximumInterval = TimeSpan.FromSeconds(10),
    };

    /** One attempt of a tool activity. */
    public static readonly TimeSpan ToolTimeout = TimeSpan.FromSeconds(30);

    /** One attempt of a model call. */
    public static readonly TimeSpan ModelTimeout = TimeSpan.FromMinutes(2);
}

/** The worker's settings the chat workflow needs, which it can't read from the environment itself. */
public sealed record WorkerConfig(
    [property: JsonPropertyName("task_queue")] string TaskQueue,
    [property: JsonPropertyName("open_account_task_queue")] string OpenAccountTaskQueue,
    [property: JsonPropertyName("llm_task_queue")] string LlmTaskQueue,
    [property: JsonPropertyName("model")] string Model)
{
    /** The default OpenAI model, as in the OpenAI Agents frameworks. Override it with OPENAI_MODEL. */
    public const string DefaultModel = "gpt-4o";

    public static WorkerConfig FromEnvironment() => new(
        Common.TaskQueues.Chat(),
        Common.TaskQueues.OpenAccount(),
        Common.TaskQueues.Llm(),
        Common.Env.Get("OPENAI_MODEL", DefaultModel));
}
