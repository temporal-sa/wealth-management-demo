// The chat workflow with the scripted model: agents as tools, the trace, the model calls on their own task queue,
// the sub-agents' memory across turns, the approvals for deletes and closes, the KYC guard and the business rule.
using Temporalio.Client;
using WealthManagement.Durable;

namespace WealthManagement.Tests;

[Collection("temporal")]
public class ChatTests(TemporalFixture fixture)
{
    [Fact]
    public async Task DelegatesToTheBeneficiaryAgentAsAToolAndRecordsTheTrace()
    {
        ScriptedChatClient.Reset(Scripts.Demo());
        var t = TestWorker.Create(fixture.Env);
        await t.RunAsync(async () =>
        {
            var handle = await t.StartChatAsync("beneficiaries");
            var reply = await Wait.SendAsync(handle, "Who are my beneficiaries?");
            Assert.Contains("John", reply.TextResponse);
            Assert.Contains("b-1b011a72", reply.JsonResponse);
            Assert.Equal(
                ["Handed off from Supervisor Agent to Beneficiary Agent", "Beneficiary Agent: Calling a tool: list_beneficiaries"],
                reply.AgentTrace.Trim().Split('\n'));
        });
    }

    [Fact]
    public async Task RunsEveryModelCallAsAnActivityOnTheModelTaskQueue()
    {
        ScriptedChatClient.Reset(Scripts.Demo());
        var t = TestWorker.Create(fixture.Env);
        await t.RunAsync(async () =>
        {
            var handle = await t.StartChatAsync("llm-queue");
            await Wait.SendAsync(handle, "What investments do I have?");
            Assert.Equal([AgentKind.Supervisor, AgentKind.Investment, AgentKind.Investment, AgentKind.Supervisor],
                ScriptedChatClient.Calls.Select(c => c.Agent));
            Assert.All(ScriptedChatClient.Calls, c =>
            {
                Assert.Equal(t.LlmTaskQueue, c.TaskQueue);
                Assert.Equal(handle.Id, c.WorkflowId);
            });
        });
    }

    [Fact]
    public async Task KeepsEachSubAgentForTheWholeChat()
    {
        ScriptedChatClient.Reset(Scripts.Demo());
        var t = TestWorker.Create(fixture.Env);
        await t.RunAsync(async () =>
        {
            var handle = await t.StartChatAsync("memory");
            await Wait.SendAsync(handle, "Who are my beneficiaries?");
            await Wait.SendAsync(handle, "Who are my beneficiaries again?");
            var second = ScriptedChatClient.Requests.Last(r => r.Agent == AgentKind.Beneficiary);
            // The beneficiary agent's session still holds the first turn's tool result
            Assert.Equal(2, second.AllResults.Count(r => r.Contains("b-1b011a72")));
        });
    }

    [Fact]
    public async Task AsksTheCustomerToConfirmADeleteAndRunsItWhenTheySayYes()
    {
        ScriptedChatClient.Reset(Scripts.Demo());
        var t = TestWorker.Create(fixture.Env);
        await t.RunAsync(async () =>
        {
            var handle = await t.StartChatAsync("confirm");
            var asked = await Wait.SendAsync(handle, "Delete beneficiary John Doe");
            Assert.Contains("needs the customer's confirmation", asked.TextResponse);
            Assert.Contains("beneficiary ID b-1b011a72", asked.TextResponse);
            Assert.Contains("Beneficiary Agent: Asking the customer to confirm delete_beneficiary", asked.AgentTrace);
            Assert.Equal(3, t.Store.ListBeneficiaries("123").Count);

            var yes = await Wait.SendAsync(handle, "Yes, delete him");
            Assert.Contains("Beneficiary deleted", yes.TextResponse);
            Assert.Contains("Beneficiary Agent: The customer confirmed delete_beneficiary", yes.AgentTrace);
            Assert.Contains("Beneficiary Agent: Calling a tool: delete_beneficiary", yes.AgentTrace);
            Assert.Equal(2, t.Store.ListBeneficiaries("123").Count);
        });
    }

    [Fact]
    public async Task DoesNotCloseTheAccountWhenTheCustomerSaysNo()
    {
        ScriptedChatClient.Reset(Scripts.Demo());
        var t = TestWorker.Create(fixture.Env);
        await t.RunAsync(async () =>
        {
            var handle = await t.StartChatAsync("confirm-no");
            var asked = await Wait.SendAsync(handle, "Close my Checking account");
            Assert.Contains("investment ID i-1", asked.TextResponse);
            var no = await Wait.SendAsync(handle, "No, keep it");
            Assert.Contains("rejected", no.TextResponse);
            Assert.Contains("The customer said no.", no.TextResponse);
            Assert.DoesNotContain("Calling a tool: close_investment", no.AgentTrace);
            Assert.Contains(t.Store.ListInvestments("123"), i => i.Name == "Checking");
            Assert.Equal(3, t.Store.ListInvestments("123").Count);
        });
    }

    [Fact]
    public async Task RejectsAConfirmationThatDoesNotComeInTheVeryNextMessage()
    {
        Assert.True(WealthManagementWorkflow.AnsweredInTime(1, 2));
        Assert.False(WealthManagementWorkflow.AnsweredInTime(1, 3));
        Assert.False(WealthManagementWorkflow.AnsweredInTime(2, 2));

        ScriptedChatClient.Reset(Scripts.Demo());
        var t = TestWorker.Create(fixture.Env);
        await t.RunAsync(async () =>
        {
            var handle = await t.StartChatAsync("confirm-late");
            await Wait.SendAsync(handle, "Delete beneficiary John Doe");
            await Wait.SendAsync(handle, "What investments do I have?");
            var late = await Wait.SendAsync(handle, "Who are my beneficiaries?");
            Assert.Contains("Beneficiary Agent: The customer did not confirm delete_beneficiary", late.AgentTrace);
            Assert.Equal(3, t.Store.ListBeneficiaries("123").Count);
        });
    }

    [Fact]
    public async Task PassesAYesThatAnswersNothingOnAsAnOrdinaryRequest()
    {
        // The supervisor sets confirmed although no confirmation was asked for
        var demo = Scripts.Demo();
        ScriptedChatClient.Reset(r => r.Agent == AgentKind.Supervisor && r.ResultsThisTurn.Count == 0 && r.LastUserText == "Yes, list them"
            ? new Call("beneficiary_assistant", new() { ["client_id"] = "123", ["request"] = "Yes, list them", ["confirmed"] = true })
            : demo(r));
        var t = TestWorker.Create(fixture.Env);
        await t.RunAsync(async () =>
        {
            var handle = await t.StartChatAsync("nothing-to-confirm");
            var yes = await Wait.SendAsync(handle, "Yes, list them");
            Assert.Contains("Beneficiary Agent: Nothing was waiting for the customer's confirmation", yes.AgentTrace);
            Assert.Contains("John", yes.TextResponse);
            var request = ScriptedChatClient.Requests.First(r => r.Agent == AgentKind.Beneficiary);
            Assert.EndsWith(WealthManagementWorkflow.NothingToConfirm, request.LastUserText);
            Assert.Equal(3, t.Store.ListBeneficiaries("123").Count);
        });
    }

    [Fact]
    public async Task DoesNotApproveKycInTheTurnTheDetailsWereFetchedAndDoesOnceTheCustomerConfirms()
    {
        Assert.False(WealthManagementWorkflow.KycConfirmed(null, 3));
        Assert.False(WealthManagementWorkflow.KycConfirmed(3, 3));
        Assert.True(WealthManagementWorkflow.KycConfirmed(2, 3));

        // The open-account agent tries to approve KYC right after fetching the details
        ScriptedChatClient.Reset(Scripts.Demo(eager: true));
        var t = TestWorker.Create(fixture.Env);
        await t.RunAsync(async () =>
        {
            var handle = await t.StartChatAsync("kyc");
            var opening = $"OpenAccount-{handle.Id}-123-Vacation-1";
            var reply = await Wait.SendAsync(handle, "Open Vacation with $500");
            Assert.Contains("Don", reply.JsonResponse);
            Assert.Contains(WealthManagementWorkflow.KycNotApproved, reply.JsonResponse);
            Assert.Contains("Handed off from Investment Agent to Open Account Agent", reply.AgentTrace);
            await Wait.ForAsync(async () => (await Wait.OpeningStatesAsync(handle)).GetValueOrDefault(opening) == States.WaitingKyc ? "" : null, "Waiting KYC");
            await Task.Delay(500);
            Assert.Equal(States.WaitingKyc, await t.Client.GetWorkflowHandle<OpenInvestmentAccountWorkflow>(opening).QueryAsync(wf => wf.GetCurrentState()));

            var yes = await Wait.SendAsync(handle, "Yes, that is correct");
            Assert.Contains("KYC approved", yes.TextResponse);
            await Wait.ForAsync(async () => (await Wait.OpeningStatesAsync(handle)).GetValueOrDefault(opening) == States.WaitingCompliance ? "" : null, "Waiting Compliance Review");
        });
    }

    [Fact]
    public async Task TellsTheOpenAccountAgentTheStatusOfEachOpeningOnEveryRequest()
    {
        ScriptedChatClient.Reset(Scripts.Demo());
        var t = TestWorker.Create(fixture.Env);
        await t.RunAsync(async () =>
        {
            var handle = await t.StartChatAsync("summary");
            await Wait.SendAsync(handle, "Open Vacation with $500");
            await Wait.SendAsync(handle, "Yes");
            var last = ScriptedChatClient.Requests.Last(r => r.Agent == AgentKind.OpenAccount);
            Assert.StartsWith("The client ID is 123. Current status of account openings in this conversation: Vacation", last.LastUserText);
        });
    }

    [Fact]
    public async Task RefusesADepositOutsideTheLimitsBeforeAnyWorkflowStarts()
    {
        ScriptedChatClient.Reset(Scripts.Demo());
        var t = TestWorker.Create(fixture.Env);
        await t.RunAsync(async () =>
        {
            var handle = await t.StartChatAsync("business-rule");
            var big = await Wait.SendAsync(handle, "Open Yacht with $2,000,000");
            Assert.Contains("cannot be opened: Initial deposits over $1,000,000.00", big.TextResponse);
            var small = await Wait.SendAsync(handle, "Open Piggy with $50");
            Assert.Contains("cannot be opened: The initial deposit must be at least $100.00", small.TextResponse);
            Assert.Empty(await Wait.OpeningStatesAsync(handle));
            // A refused request doesn't use up a number: the next opening is -1
            await Wait.SendAsync(handle, "Open Vacation with $500");
            Assert.Contains($"OpenAccount-{handle.Id}-123-Vacation-1", (await Wait.OpeningStatesAsync(handle)).Keys);
        });
    }
}
