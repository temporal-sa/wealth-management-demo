// The standalone version: the agents as a command-line chat, with Microsoft Agent Framework and no Temporal. The
// same "agents as tools" design as the Temporal version: the supervisor delegates to a beneficiary agent and an
// investment agent, called as tools that keep each agent's session, and the tools call the data files directly.
// Accounts are opened directly by one tool, so there is no KYC, compliance review or saga, deletes and closes need
// no confirmation, and nothing survives a crash or an outage.
//
// Run it from src/dotnet/agent_framework with `dotnet run --project Standalone`.
using System.ClientModel;
using System.ComponentModel;
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;
using OpenAI;
using WealthManagement.Common;

var model = Env.Get("OPENAI_MODEL", "gpt-4o");
var apiKey = Env.Get("OPENAI_API_KEY");
if (apiKey == "")
{
    Console.Error.WriteLine("OPENAI_API_KEY is not set (see scripts/setoaikey.example)");
    return 1;
}
// Without Temporal, the OpenAI client's own retries are all there is
var chatClient = new OpenAIClient(new ApiKeyCredential(apiKey)).GetChatClient(model).AsIChatClient();
var store = DataStore.FromEnvironment();

AIFunction Tool(Delegate method, string name, string description) => AIFunctionFactory.Create(method, name, description);

var beneficiaryAgent = new ChatClientAgent(chatClient, Prompts.BeneficiaryInstructions, Prompts.BeneficiaryAgentName,
    "Handle a beneficiary request (list, add, or delete beneficiaries).",
    [
        Tool(([Description("The customer's client ID")] string client_id) => store.ListBeneficiaries(client_id),
            "list_beneficiaries", "List a client's beneficiaries."),
        Tool(([Description("The customer's client ID")] string client_id, string first_name, string last_name, string relationship) =>
            {
                store.AddBeneficiary(new NewBeneficiary(client_id, first_name, last_name, relationship));
                return $"Beneficiary {first_name} {last_name} added.";
            },
            "add_beneficiary", "Add a new beneficiary for a client."),
        Tool(([Description("The customer's client ID")] string client_id, string beneficiary_id) =>
            {
                store.DeleteBeneficiary(client_id, beneficiary_id);
                return "Beneficiary deleted.";
            },
            "delete_beneficiary", "Delete a client's beneficiary by its beneficiary ID."),
    ]);

var investmentAgent = new ChatClientAgent(chatClient, Prompts.InvestmentInstructions, Prompts.InvestmentAgentName,
    "Handle an investment-account request (list, open, or close investment accounts).",
    [
        Tool(([Description("The customer's client ID")] string client_id) => store.ListInvestments(client_id),
            "list_investments", "List a client's investment accounts and their balances."),
        Tool(([Description("The customer's client ID")] string client_id, string name, double balance) =>
            {
                if (balance < 100) return "The account cannot be opened: the initial deposit must be at least $100.00";
                if (balance > 1_000_000)
                {
                    return "The account cannot be opened: initial deposits over $1,000,000.00 cannot be opened online and must be arranged with a wealth advisor";
                }
                return (object)store.AddInvestment(new InvestmentAccount(client_id, name, balance));
            },
            "open_investment", "Open a new investment account with an initial deposit."),
        Tool(([Description("The customer's client ID")] string client_id, string investment_id) =>
            {
                store.DeleteInvestment(client_id, investment_id);
                return "Investment account closed.";
            },
            "close_investment", "Close a client's investment account by its investment ID."),
    ]);

// The specialized agents as tools: each keeps its own session for the whole chat, as in the Temporal version
var beneficiarySession = await beneficiaryAgent.CreateSessionAsync();
var investmentSession = await investmentAgent.CreateSessionAsync();
var trace = new List<string>();
var supervisor = new ChatClientAgent(chatClient, Prompts.SupervisorInstructions, Prompts.SupervisorAgentName, null,
    [
        Tool(async ([Description("The customer's client ID")] string client_id, [Description("What the customer wants done, in their words")] string request) =>
            {
                trace.Add($"Handed off from {Prompts.SupervisorAgentName} to {Prompts.BeneficiaryAgentName}");
                return (await beneficiaryAgent.RunAsync($"The client ID is {client_id}. {request}", beneficiarySession)).Text;
            },
            "beneficiary_assistant", "Handle a beneficiary request (list, add, or delete beneficiaries)."),
        Tool(async ([Description("The customer's client ID")] string client_id, [Description("What the customer wants done, in their words")] string request) =>
            {
                trace.Add($"Handed off from {Prompts.SupervisorAgentName} to {Prompts.InvestmentAgentName}");
                return (await investmentAgent.RunAsync($"The client ID is {client_id}. {request}", investmentSession)).Text;
            },
            "investment_assistant", "Handle an investment-account request (list, open, or close investment accounts)."),
    ]);
var session = await supervisor.CreateSessionAsync();

Console.WriteLine($"Using model {model}. Type exit, end or quit to leave.");
Console.WriteLine("Welcome to ABC Wealth Management. How can I help you?");
while (true)
{
    Console.Write("Enter your message: ");
    var line = Console.ReadLine();
    if (line == null) break;
    var input = line.Trim();
    if (input.ToLowerInvariant() is "exit" or "end" or "quit") break;
    if (input == "") continue;
    trace.Clear();
    try
    {
        var reply = await supervisor.RunAsync(input, session);
        foreach (var t in trace) Console.WriteLine($"  [{t}]");
        Console.WriteLine($"{Prompts.SupervisorAgentName}: {reply.Text.Trim()}");
    }
    catch (Exception e)
    {
        // Without Temporal, a failed model call loses the turn: the customer has to try again
        Console.WriteLine($"Error: {e.Message}");
    }
}
return 0;
