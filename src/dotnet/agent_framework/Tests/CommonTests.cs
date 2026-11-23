// The rules every framework shares: the session in a workflow ID, the open-account task queue, dollar amounts, the
// claim check's settings, and the data store's files.
using WealthManagement.Common;

namespace WealthManagement.Tests;

public class CommonTests
{
    [Fact]
    public void FindsTheSessionInAChatOrAccountOpeningWorkflowId()
    {
        var session = new string('a', 32);
        Assert.Equal(session, Session.FromWorkflowId($"maf-temporal-agent-session-{session}-chat-0123456789abcdef"));
        Assert.Equal(session, Session.FromWorkflowId($"OpenAccount-maf-temporal-agent-session-{session}-chat-0123456789abcdef-123-Vacation-1"));
        Assert.Equal(Session.Default, Session.FromWorkflowId("some-other-workflow"));
        Assert.Equal(Session.Default, Session.FromWorkflowId(null));
    }

    [Fact]
    public void PicksTheOpenAccountTaskQueue()
    {
        Assert.Equal("MAF-Supervisor", TaskQueues.OpenAccount("MAF-Supervisor", null));
        Assert.Equal("MAF-Supervisor", TaskQueues.OpenAccount("MAF-Supervisor", " "));
        Assert.Equal("MAF-Supervisor-open-account", TaskQueues.OpenAccount("MAF-Supervisor", "Java"));
        Assert.Equal("elsewhere", TaskQueues.OpenAccount("MAF-Supervisor", "elsewhere"));
    }

    [Fact]
    public void FormatsDollarAmounts()
    {
        Assert.Equal("$1,234.50", Money.Format(1234.5));
        Assert.Equal("-$300,000.00", Money.Format(-300_000));
        Assert.Equal(2.35, Money.Round2(2.345));
    }

    [Fact]
    public void ReadsTheClaimCheckSettings()
    {
        Assert.True(ClaimCheckSetting.Enabled("Yes"));
        Assert.False(ClaimCheckSetting.Enabled("off"));
        Assert.Equal(ClaimCheckCodec.DefaultTtlSeconds, ClaimCheckCodec.TtlSeconds(null));
        Assert.Equal(60, ClaimCheckCodec.TtlSeconds("60"));
        Assert.Equal(0, ClaimCheckCodec.TtlSeconds("-5"));
    }

    [Fact]
    public void KeepsTheDataFilesFormatAndMovesMoneyOnlyOncePerTransfer()
    {
        var dir = TestWorker.FreshDataDir();
        var store = new DataStore(dir);
        var added = store.AddBeneficiary(new NewBeneficiary("123", "Jim", "Doe", "Brother"));
        Assert.StartsWith("b-", added.BeneficiaryId);
        Assert.Contains("\n    \"123\": [", File.ReadAllText(Path.Combine(dir, "beneficiaries.json")));
        var first = store.Debit("123", 100, "t-1");
        var again = store.Debit("123", 100, "t-1");
        Assert.Equal(first, again);
        Assert.Throws<InsufficientFundsException>(() => store.Debit("123", 10_000_000, "t-2"));
        Assert.Equal("Client information successfully updated", store.UpdateClient("123", new Dictionary<string, string> { ["phone"] = "555" }));
        Assert.Equal("555", store.GetClient("123")!.Phone);
    }
}
