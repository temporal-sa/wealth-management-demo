// Failure scenarios: retries through a tool and a model outage, the 429's retry delay, the model flags read inside
// the model activity for the chat's own workflow, the saga's success and its rollbacks, the saga states reported
// to the chat, the bug in workflow code pausing the workflow without failing it, and repeat openings.
using Temporalio.Api.Enums.V1;
using Temporalio.Api.WorkflowService.V1;
using Temporalio.Client;
using WealthManagement.Common;
using WealthManagement.Durable;

namespace WealthManagement.Tests;

[Collection("temporal")]
public class FailureTests(TemporalFixture fixture)
{
    private static InMemoryChaos ChaosOf(TestWorker t) => (InMemoryChaos)t.Chaos;

    [Fact]
    public async Task WaitsOutACoreBankingOutageMidTurnAndNothingIsLostOrAskedAgain()
    {
        ScriptedChatClient.Reset(Scripts.Demo());
        var t = TestWorker.Create(fixture.Env);
        await t.RunAsync(async () =>
        {
            var handle = await t.StartChatAsync("tool-down");
            ChaosOf(t).Set(Chaos.ToolDown, true);
            var reply = Wait.SendAsync(handle, "Who are my beneficiaries?");
            await Wait.ForAsync(() => Task.FromResult(ChaosOf(t).Events.Any(e => e.Source == "list_beneficiaries") ? "" : null), "the outage");
            await Task.Delay(1500);
            Assert.Empty(await handle.QueryAsync(wf => wf.GetChatHistory()));
            var modelCalls = ScriptedChatClient.Calls.Count;
            ChaosOf(t).Set(Chaos.ToolDown, false);
            Assert.Contains("John", (await reply).TextResponse);
            // The turn resumed after the tool: the model calls before it were not made again
            Assert.Equal(modelCalls + 2, ScriptedChatClient.Calls.Count);
        });
    }

    [Fact]
    public async Task WaitsOutAModelOutageAndTheTurnResumesWhereItStopped()
    {
        ScriptedChatClient.Reset(Scripts.Demo());
        var t = TestWorker.Create(fixture.Env);
        await t.RunAsync(async () =>
        {
            var handle = await t.StartChatAsync("llm-down");
            await Wait.SendAsync(handle, "Who are my beneficiaries?");
            ChaosOf(t).Set(Chaos.LlmDown, true);
            var reply = Wait.SendAsync(handle, "Who are my beneficiaries again?");
            await Wait.ForAsync(() => Task.FromResult(ChaosOf(t).Events.Any(e => e.Flag == Chaos.LlmDown) ? "" : null), "the outage");
            await Task.Delay(1500);
            Assert.Single(await handle.QueryAsync(wf => wf.GetChatHistory()));
            ChaosOf(t).Set(Chaos.LlmDown, false);
            Assert.Contains("John", (await reply).TextResponse);
            // Read inside the model activity, for the chat's own workflow
            var e = ChaosOf(t).Events.First(e => e.Flag == Chaos.LlmDown);
            Assert.Equal("MicrosoftAgentFramework.InvokeModel", e.Source);
            Assert.Equal(handle.Id, e.WorkflowId);
        });
    }

    [Fact]
    public async Task DelaysTheRetryOfARateLimitedModelCallBy15Seconds()
    {
        ScriptedChatClient.Reset(Scripts.Demo());
        var t = TestWorker.Create(fixture.Env);
        await t.RunAsync(async () =>
        {
            var handle = await t.StartChatAsync("llm-429");
            ChaosOf(t).Set(Chaos.LlmRateLimited, true);
            await handle.SignalAsync(wf => wf.ProcessUserMessageAsync(new ProcessUserMessageInput("Who are my beneficiaries?")));
            var pending = await Wait.ForAsync(async () =>
            {
                var d = await t.Client.WorkflowService.DescribeWorkflowExecutionAsync(new DescribeWorkflowExecutionRequest
                {
                    Namespace = t.Client.Options.Namespace,
                    Execution = new Temporalio.Api.Common.V1.WorkflowExecution { WorkflowId = handle.Id },
                });
                return d.PendingActivities.FirstOrDefault(a => a.LastFailure != null);
            }, "a failed model call");
            var info = pending.LastFailure.ApplicationFailureInfo;
            // The integration's failure for a provider error, retryable, with the Retry-After header as the delay
            Assert.Equal("MicrosoftAgentFrameworkModelError", info.Type);
            Assert.False(info.NonRetryable);
            Assert.Equal(15, info.NextRetryDelay.Seconds);
            var failedAt = pending.LastAttemptCompleteTime.Seconds;
            var nextAt = pending.NextAttemptScheduleTime.Seconds;
            Assert.True(nextAt - failedAt >= 14, $"next attempt {nextAt - failedAt}s after the failure");
            await handle.TerminateAsync("test done");
        });
    }

    // -------------------------------------------------------------------------
    // The open-account workflow on its own
    // -------------------------------------------------------------------------

    private static async Task<WorkflowHandle<OpenInvestmentAccountWorkflow, OpenInvestmentAccountOutput>> OpenAsync(TestWorker t, string name, double amount, string? promo = null)
    {
        var handle = await t.Client.StartWorkflowAsync(
            (OpenInvestmentAccountWorkflow wf) => wf.RunAsync(new OpenInvestmentAccountInput("123", name, amount, promo)),
            new WorkflowOptions($"open-{name}-{Guid.NewGuid():N}", t.TaskQueue));
        await handle.SignalAsync(wf => wf.VerifyKycAsync());
        await handle.SignalAsync(wf => wf.ComplianceApprovedAsync());
        return handle;
    }

    [Fact]
    public async Task OpensTheAccountCreatingTheRecordDebitingTheLinkedAccountAndRegisteringIt()
    {
        var t = TestWorker.Create(fixture.Env);
        await t.RunAsync(async () =>
        {
            var result = await (await OpenAsync(t, "Vacation", 5000)).GetResultAsync();
            Assert.True(result.AccountCreated);
            Assert.Contains(t.Store.ListInvestments("123"), i => i.Name == "Vacation" && i.Balance == 5000);
        });
    }

    [Fact]
    public async Task RollsBackInReverseOrderWhenTheCustodianRejectsTheAccount()
    {
        var t = TestWorker.Create(fixture.Env);
        ChaosOf(t).Set(Chaos.CustodianRejects, true);
        await t.RunAsync(async () =>
        {
            var result = await (await OpenAsync(t, "Rejected", 5000)).GetResultAsync();
            Assert.False(result.AccountCreated);
            Assert.Contains("The custodian rejected the account registration", result.Message);
            Assert.DoesNotContain(t.Store.ListInvestments("123"), i => i.Name == "Rejected");
        });
    }

    [Fact]
    public async Task RollsBackWhenTheLinkedAccountHasInsufficientFunds()
    {
        var t = TestWorker.Create(fixture.Env);
        await t.RunAsync(async () =>
        {
            var result = await (await OpenAsync(t, "Big", 300_000)).GetResultAsync();
            Assert.False(result.AccountCreated);
            Assert.Contains("not enough to transfer $300,000.00", result.Message);
            Assert.DoesNotContain(t.Store.ListInvestments("123"), i => i.Name == "Big");
        });
    }

    [Fact]
    public async Task ReportsEverySagaStateToTheParentChatInOrder()
    {
        ScriptedChatClient.Reset(Scripts.Demo());
        var t = TestWorker.Create(fixture.Env);
        await t.RunAsync(async () =>
        {
            var chat = await t.StartChatAsync("states");
            var opening = $"OpenAccount-{chat.Id}-123-Vacation-1";
            await Wait.SendAsync(chat, "Open Vacation with $5,000");
            await Wait.SendAsync(chat, "Yes");
            await t.Client.GetWorkflowHandle<OpenInvestmentAccountWorkflow>(opening).SignalAsync(wf => wf.ComplianceApprovedAsync());
            await Wait.ForAsync(async () => (await Wait.OpeningStatesAsync(chat)).GetValueOrDefault(opening) == States.Complete ? "" : null, "Complete");
            await Wait.ForAsync(() => Task.FromResult(t.Events.Events[chat.Id].Any(e => e.Contains("status changed: Complete")) ? "" : null), "the status events");
            var statuses = t.Events.Events[chat.Id].Where(e => e.Contains("status_update")).Select(e => e[(e.IndexOf("changed: ") + 9)..^3]).ToList();
            Assert.Equal(
                [States.WaitingKyc, States.WaitingCompliance, States.ComplianceApproved, States.CreatingRecord,
                 "Transferring $5,000.00 from the linked bank account.", States.Registering, States.Complete],
                statuses);
        });
    }

    [Fact]
    public async Task PausesOnTheBugInWorkflowCodeTheWorkflowTaskFailsAndTheWorkflowStaysRunning()
    {
        var t = TestWorker.Create(fixture.Env);
        await t.RunAsync(async () =>
        {
            var handle = await OpenAsync(t, "Bonus", 5000, BusinessRules.WelcomeBonusPromoCode);
            await Wait.ForAsync(async () =>
            {
                var events = await handle.FetchHistoryAsync();
                return events.Events.Any(e => e.EventType == EventType.WorkflowTaskFailed) ? "" : null;
            }, "a failed workflow task");
            Assert.Equal(WorkflowExecutionStatus.Running, (await handle.DescribeAsync()).Status);
            // The failure is the bug, and the compliance approval is kept: no query, which a failing workflow can't answer
            var history = await handle.FetchHistoryAsync();
            var failed = history.Events.First(e => e.EventType == EventType.WorkflowTaskFailed);
            Assert.Contains("given key 'WELCOME-BONUS' was not present", failed.WorkflowTaskFailedEventAttributes.Failure.Message);
            Assert.Contains(history.Events, e => e.WorkflowExecutionSignaledEventAttributes?.SignalName == Names.ComplianceApprovedSignal);
            await handle.TerminateAsync("test done");
        });
    }

    [Fact]
    public async Task StartsANewNumberedOpeningWithItsOwnKycForEveryRequest()
    {
        ScriptedChatClient.Reset(Scripts.Demo());
        var t = TestWorker.Create(fixture.Env);
        await t.RunAsync(async () =>
        {
            var chat = await t.StartChatAsync("repeat");
            await Wait.SendAsync(chat, "Open Vacation with $500");
            await Wait.SendAsync(chat, "Yes");
            await Wait.SendAsync(chat, "Open Vacation with $600");
            var states = await Wait.OpeningStatesAsync(chat);
            Assert.Equal(States.WaitingCompliance, states[$"OpenAccount-{chat.Id}-123-Vacation-1"]);
            await Wait.ForAsync(async () => (await Wait.OpeningStatesAsync(chat)).GetValueOrDefault($"OpenAccount-{chat.Id}-123-Vacation-2") == States.WaitingKyc ? "" : null, "the second opening's KYC");
        });
    }
}

/** A chat with no message or status update for an hour ends by itself, on a time-skipping test server. */
public class IdleTests
{
    [Fact]
    public async Task CompletesByItselfAfterAnHourWithoutCustomerMessagesOrStatusUpdates()
    {
        await using var env = await Temporalio.Testing.WorkflowEnvironment.StartTimeSkippingAsync();
        ScriptedChatClient.Reset(Scripts.Demo());
        var t = TestWorker.Create(env);
        await t.RunAsync(async () =>
        {
            var handle = await t.StartChatAsync("idle");
            await env.DelayAsync(TimeSpan.FromMinutes(61));
            await handle.GetResultAsync();
            Assert.Equal(WorkflowExecutionStatus.Completed, (await handle.DescribeAsync()).Status);
        });
    }
}
