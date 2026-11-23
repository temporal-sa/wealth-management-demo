using Microsoft.Extensions.Logging;
using Temporalio.Exceptions;
using Temporalio.Workflows;
using WealthManagement.Common;

namespace WealthManagement.Durable;

/**
 * OpenInvestmentAccountWorkflow: one account opening, started by the chat workflow as a child. It loads the
 * client's details, waits for KYC and a compliance officer's approval, then runs a saga that creates, funds and
 * registers the account, undoing the completed steps in reverse order if one fails for a business reason. Every
 * state change is signalled to the parent chat workflow.
 *
 * It is interchangeable with the Java workflow in interop/open_account/java: the same handlers, states, transfer
 * IDs and activity calls.
 */
[Workflow(Names.OpenInvestmentAccountWorkflow)]
public class OpenInvestmentAccountWorkflow
{
    // Welcome-bonus promotion: a share of the initial deposit, up to a maximum
    private sealed record Promotion(double Rate);

    private const double MaxBonus = 500;

    // *** Bug-In-Workflow-Code ***
    // A deliberate bug for the "Bug in workflow code" chaos flag: the promo code is WELCOME-BONUS (a hyphen), but
    // the promotion is keyed WELCOME_BONUS (an underscore), so looking it up throws KeyNotFoundException. That fails
    // the workflow task, not the workflow: the workflow stays Running with the compliance approval kept, and
    // Temporal retries the task. To fix it, uncomment the first line below, delete the second, and restart the
    // worker: the opening resumes and completes with the bonus.
    // private static readonly Dictionary<string, Promotion> Promotions = new() { ["WELCOME-BONUS"] = new(0.01) };
    private static readonly Dictionary<string, Promotion> Promotions = new() { ["WELCOME_BONUS"] = new(0.01) };

    // The activities run on the chat worker's task queue, so a Java open-account workflow on another queue calls
    // the same ones. One attempt may take 30 seconds; an outage is retried for as long as it lasts.
    private static readonly ActivityOptions Tool = new()
    {
        StartToCloseTimeout = RetryPolicies.ToolTimeout,
        RetryPolicy = RetryPolicies.Tool,
    };

    private string state = States.Initializing;
    private bool initialized;
    private bool kycVerified;
    private bool complianceReviewed;
    private WealthManagementClient? client;
    private string clientId = "";

    [WorkflowQuery(Names.GetCurrentStateQuery)]
    public string GetCurrentState() => state;

    // Each handler waits for the steps before it, so an early signal takes effect once the workflow gets there:
    // KYC once the details are loaded, compliance once KYC is verified.
    [WorkflowSignal(Names.VerifyKycSignal)]
    public async Task VerifyKycAsync()
    {
        await Workflow.WaitConditionAsync(() => initialized);
        kycVerified = true;
    }

    [WorkflowSignal(Names.ComplianceApprovedSignal)]
    public async Task ComplianceApprovedAsync()
    {
        await Workflow.WaitConditionAsync(() => initialized && kycVerified);
        complianceReviewed = true;
    }

    // An update rather than a query, so a caller that asks right after the start waits until the details have
    // been loaded instead of getting nothing
    [WorkflowUpdate(Names.GetClientDetailsUpdate)]
    public async Task<WealthManagementClient?> GetClientDetailsAsync()
    {
        await Workflow.WaitConditionAsync(() => initialized);
        return client;
    }

    // The customer changed their details during KYC: save them, which also completes KYC
    [WorkflowUpdate(Names.UpdateClientDetailsUpdate)]
    public async Task<string> UpdateClientDetailsAsync(Dictionary<string, string?> fields)
    {
        await Workflow.WaitConditionAsync(() => initialized);
        var result = await Workflow.ExecuteActivityAsync(
            (WealthActivities a) => a.UpdateClient(clientId, fields), Tool);
        client = client?.With(WealthActivities.Changed(fields));
        kycVerified = true;
        return result;
    }

    [WorkflowRun]
    public async Task<OpenInvestmentAccountOutput> RunAsync(OpenInvestmentAccountInput input)
    {
        clientId = input.ClientId;
        Workflow.Logger.LogInformation("OpenInvestmentAccountWorkflow started: client {ClientId}, account {AccountName}, {Amount}, promo {Promo}",
            input.ClientId, input.AccountName, input.InitialAmount, input.PromoCode);
        client = await Workflow.ExecuteActivityAsync((WealthActivities a) => a.GetClient(input.ClientId), Tool);
        initialized = true;
        await SetStateAsync(input.AccountName, States.WaitingKyc);

        await Workflow.WaitConditionAsync(() => kycVerified);
        await SetStateAsync(input.AccountName, States.WaitingCompliance);

        await Workflow.WaitConditionAsync(() => complianceReviewed);
        await SetStateAsync(input.AccountName, States.ComplianceApproved);
        var output = await OpenAccountAsync(input);
        // Let a status check that is still running finish before the workflow completes
        await Workflow.WaitConditionAsync(() => Workflow.AllHandlersFinished);
        return output;
    }

    // Every state change is visible to get_current_state and signalled to the parent chat workflow, which keeps it
    // for the agent's get_account_opening_status tool and shows it in the web UI. A workflow started on its own has
    // no parent to tell.
    private async Task SetStateAsync(string accountName, string newState)
    {
        state = newState;
        Workflow.Logger.LogInformation("State: {State} ({AccountName})", newState, accountName);
        if (Workflow.Info.Parent is not { } parent) return;
        await Workflow.GetExternalWorkflowHandle(parent.WorkflowId).SignalAsync(
            Names.UpdateAccountOpeningStateSignal,
            [new UpdateAccountOpeningStateInput(accountName, newState, Workflow.Info.WorkflowId)]);
    }

    private static double WelcomeBonus(string promoCode, double initialAmount) =>
        Math.Min(initialAmount * Promotions[promoCode].Rate, MaxBonus);

    // The saga: each completed step registers how to undo it. If a later step fails with a non-retryable error,
    // the compensations run in reverse order. Transient failures never get here: the activities retry until they
    // succeed.
    private async Task<OpenInvestmentAccountOutput> OpenAccountAsync(OpenInvestmentAccountInput input)
    {
        var (id, name, amount) = (input.ClientId, input.AccountName, input.InitialAmount);
        var bonus = input.PromoCode is { } code ? WelcomeBonus(code, amount) : 0;
        // Idempotency key: stable across activity retries and worker restarts. The run ID keeps a workflow ID
        // started again by hand from looking like a repeat of an earlier transfer.
        var transferId = $"{Workflow.Info.WorkflowId}-{Workflow.Info.RunId}-initial-deposit";
        var compensations = new List<(string Description, Func<Task> Undo)>();
        try
        {
            await SetStateAsync(name, States.CreatingRecord);
            var account = await Workflow.ExecuteActivityAsync(
                (WealthActivities a) => a.OpenInvestment(new InvestmentAccount(id, name, amount + bonus)), Tool);
            compensations.Insert(0, ("removing the account record",
                () => Workflow.ExecuteActivityAsync((WealthActivities a) => a.RemoveInvestment(id, account.InvestmentId), Tool)));

            await SetStateAsync(name, $"Transferring {Money.Format(amount)} from the linked bank account.");
            await Workflow.ExecuteActivityAsync((WealthActivities a) => a.DebitLinkedAccount(id, amount, transferId), Tool);
            compensations.Insert(0, ($"refunding {Money.Format(amount)} to the linked bank account",
                () => Workflow.ExecuteActivityAsync((WealthActivities a) => a.CreditLinkedAccount(id, amount, $"{transferId}-refund"), Tool)));

            await SetStateAsync(name, States.Registering);
            await Workflow.ExecuteActivityAsync((WealthActivities a) => a.RegisterAccount(id, account.InvestmentId, amount), Tool);
        }
        catch (ActivityFailureException e)
        {
            var reason = e.InnerException is ApplicationFailureException app ? app.Message : e.InnerException?.Message ?? e.Message;
            await SetStateAsync(name, $"Failed: {reason}. Rolling back.");
            foreach (var (description, undo) in compensations)
            {
                await SetStateAsync(name, $"Rolling back: {description}.");
                // Compensations are activities too, so they are retried until they succeed
                await undo();
            }
            await SetStateAsync(name, $"Rolled back. The account was not opened: {reason}.");
            return new OpenInvestmentAccountOutput(false, $"The account was not opened: {reason}");
        }

        await SetStateAsync(name, States.Complete);
        return new OpenInvestmentAccountOutput(true, "investment account created");
    }
}
