using Microsoft.Extensions.Logging;
using Temporalio.Activities;
using Temporalio.Client;
using Temporalio.Exceptions;
using WealthManagement.Common;

namespace WealthManagement.Durable;

/**
 * Every activity: the tools' (beneficiaries, investments, the chat side of an account opening), the saga's, and
 * the event stream's. The names and positional arguments match every other framework's, so the Java open-account
 * workflow calls the saga activities here, on this framework's task queue.
 */
public sealed class WealthActivities(DataStore store, IEventStream events, Chaos chaos, Func<ITemporalClient> client, WorkerConfig config)
{
    private static ILogger Log => ActivityExecutionContext.Current.Logger;

    // ---- Beneficiaries

    [Activity("list_beneficiaries")]
    public List<Beneficiary> ListBeneficiaries(string clientId)
    {
        Log.LogInformation("list_beneficiaries client_id={ClientId}", clientId);
        chaos.CoreBankingApi();
        return store.ListBeneficiaries(clientId);
    }

    [Activity("add_beneficiary")]
    public Beneficiary AddBeneficiary(NewBeneficiary b)
    {
        Log.LogInformation("add_beneficiary client_id={ClientId}", b.ClientId);
        chaos.CoreBankingApi();
        return store.AddBeneficiary(b);
    }

    [Activity("delete_beneficiary")]
    public bool DeleteBeneficiary(string clientId, string beneficiaryId)
    {
        Log.LogInformation("delete_beneficiary client_id={ClientId} beneficiary_id={BeneficiaryId}", clientId, beneficiaryId);
        chaos.CoreBankingApi();
        return store.DeleteBeneficiary(clientId, beneficiaryId);
    }

    // ---- Investments

    [Activity("list_investments")]
    public List<InvestmentRecord> ListInvestments(string clientId)
    {
        Log.LogInformation("list_investments client_id={ClientId}", clientId);
        chaos.CoreBankingApi();
        return store.ListInvestments(clientId);
    }

    [Activity("close_investment")]
    public bool CloseInvestment(string clientId, string investmentId)
    {
        Log.LogInformation("close_investment client_id={ClientId} investment_id={InvestmentId}", clientId, investmentId);
        chaos.CoreBankingApi();
        return store.DeleteInvestment(clientId, investmentId);
    }

    /** The business rules for a new account. Breaking one is non-retryable: the same request would fail again. */
    [Activity("validate_new_account")]
    public void ValidateNewAccount(string clientId, string accountName, double initialAmount)
    {
        Log.LogInformation("validate_new_account client_id={ClientId} account_name={AccountName} initial_amount={Amount}", clientId, accountName, initialAmount);
        if (!(initialAmount >= BusinessRules.MinInitialDeposit))
        {
            throw new ApplicationFailureException(
                $"The initial deposit must be at least {Money.Format(BusinessRules.MinInitialDeposit)}",
                BusinessRules.DepositBelowMinimum, nonRetryable: true);
        }
        if (initialAmount > BusinessRules.MaxInitialDeposit)
        {
            throw new ApplicationFailureException(
                $"Initial deposits over {Money.Format(BusinessRules.MaxInitialDeposit)} cannot be opened online and must be arranged with a wealth advisor",
                BusinessRules.DepositLimitExceeded, nonRetryable: true);
        }
    }

    /**
     * The promo code for a new account, if a promotion is running. The chaos panel's "Bug in workflow code" switch
     * runs the welcome-bonus promotion, whose code path in the open-account workflow has a bug. The flag is read
     * here, not in the workflow, which must be deterministic.
     */
    [Activity("find_promotion")]
    public string? FindPromotion(string clientId)
    {
        Log.LogInformation("find_promotion client_id={ClientId}", clientId);
        return chaos.IsEnabled(Chaos.WorkflowBug) ? BusinessRules.WelcomeBonusPromoCode : null;
    }

    [Activity("open_investment")]
    public async Task<InvestmentRecord> OpenInvestment(InvestmentAccount newAccount)
    {
        Log.LogInformation("open_investment client_id={ClientId} name={Name} balance={Balance}", newAccount.ClientId, newAccount.Name, newAccount.Balance);
        await chaos.MaybeSlowDownAsync();
        chaos.CoreBankingApi();
        try
        {
            return store.AddInvestment(newAccount);
        }
        catch (ArgumentException)
        {
            throw new ApplicationFailureException($"Invalid opening balance {Money.Format(newAccount.Balance)}", "InvalidBalance", nonRetryable: true);
        }
    }

    /**
     * Removes an investment account record: the saga's compensation for open_investment. An account that is
     * already gone counts as removed, so a retried compensation succeeds.
     */
    [Activity("remove_investment")]
    public async Task<bool> RemoveInvestment(string clientId, string investmentId)
    {
        Log.LogInformation("remove_investment client_id={ClientId} investment_id={InvestmentId}", clientId, investmentId);
        await chaos.MaybeSlowDownAsync();
        chaos.CoreBankingApi();
        store.DeleteInvestment(clientId, investmentId);
        return true;
    }

    // ---- Clients

    [Activity("get_client")]
    public WealthManagementClient? GetClient(string clientId)
    {
        Log.LogInformation("get_client client_id={ClientId}", clientId);
        return store.GetClient(clientId);
    }

    [Activity("update_client")]
    public string UpdateClient(string clientId, Dictionary<string, string?> fieldDict)
    {
        Log.LogInformation("update_client client_id={ClientId} fields={Fields}", clientId, string.Join(",", fieldDict.Keys));
        return store.UpdateClient(clientId, Changed(fieldDict));
    }

    // ---- Funding: each call carries a transfer ID that is stable across retries, so a retried activity never
    // moves the money twice.

    [Activity("debit_linked_account")]
    public async Task<Transfer> DebitLinkedAccount(string clientId, double amount, string transferId)
    {
        Log.LogInformation("debit_linked_account client_id={ClientId} amount={Amount} transfer_id={TransferId}", clientId, amount, transferId);
        await chaos.MaybeSlowDownAsync();
        try
        {
            return store.Debit(clientId, amount, transferId);
        }
        catch (InsufficientFundsException e)
        {
            // A business-rule failure: retrying won't make the money appear
            throw new ApplicationFailureException(e.Message, BusinessRules.InsufficientFunds, nonRetryable: true);
        }
    }

    /** Refunds money to the linked bank account: the saga's compensation for debit_linked_account. */
    [Activity("credit_linked_account")]
    public async Task<Transfer> CreditLinkedAccount(string clientId, double amount, string transferId)
    {
        Log.LogInformation("credit_linked_account client_id={ClientId} amount={Amount} transfer_id={TransferId}", clientId, amount, transferId);
        await chaos.MaybeSlowDownAsync();
        return store.Credit(clientId, amount, transferId);
    }

    // ---- Custodian: the third party that holds a new account's assets

    [Activity("register_account")]
    public async Task<string> RegisterAccount(string clientId, string investmentId, double amount)
    {
        Log.LogInformation("register_account client_id={ClientId} investment_id={InvestmentId} amount={Amount}", clientId, investmentId, amount);
        await chaos.MaybeSlowDownAsync();
        chaos.Inject(Chaos.CustodianRejects, new ApplicationFailureException(
            "The custodian rejected the account registration", BusinessRules.CustodianRejected, nonRetryable: true));
        return $"CUST-{investmentId}";
    }

    // ---- Open account, chat side: these reach the open-account workflow through the Temporal client

    /** Runs the open-account workflow's get_client_details update, which waits until it has loaded them. */
    [Activity("get_current_client_info")]
    public Task<WealthManagementClient?> GetCurrentClientInfo(string workflowId) =>
        client().GetWorkflowHandle(workflowId).ExecuteUpdateAsync<WealthManagementClient?>(Names.GetClientDetailsUpdate, []);

    /** Sends the open-account workflow's verify_kyc signal. */
    [Activity("approve_kyc")]
    public Task ApproveKyc(string workflowId) =>
        client().GetWorkflowHandle(workflowId).SignalAsync(Names.VerifyKycSignal, []);

    /** Runs the open-account workflow's update_client_details update with the changed fields. It completes KYC. */
    [Activity("update_client_details")]
    public Task<string> UpdateClientDetails(string workflowId, Dictionary<string, string?> clientDetails) =>
        client().GetWorkflowHandle(workflowId).ExecuteUpdateAsync<string>(Names.UpdateClientDetailsUpdate, [clientDetails]);

    // ---- Event stream: the conversation the web UI polls (events:<workflow ID> in Redis)

    [Activity("append_chat_interaction")]
    public long AppendChatInteraction(string workflowId, ChatInteraction chatInteraction) =>
        events.Append(workflowId, IEventStream.ChatInteraction, chatInteraction);

    [Activity("append_status_update")]
    public long AppendStatusUpdate(string workflowId, StatusUpdate statusUpdate) =>
        events.Append(workflowId, IEventStream.StatusUpdate, statusUpdate);

    [Activity("delete_conversation")]
    public bool DeleteConversation(string workflowId) => events.Delete(workflowId);

    // ---- Not part of the shared contract

    /** The worker's settings, for the chat workflow, which can't read the environment itself. */
    [Activity("get_worker_config")]
    public WorkerConfig GetWorkerConfig() => config;

    /** The fields that change: set, non-empty ones only. */
    public static Dictionary<string, string> Changed(IReadOnlyDictionary<string, string?> fields) =>
        fields.Where(f => !string.IsNullOrEmpty(f.Value)).ToDictionary(f => f.Key, f => f.Value!);
}
