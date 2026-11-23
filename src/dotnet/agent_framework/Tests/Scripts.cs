// Scripts for the scripted model: each agent does what the demo's agents do, with no model.
//
// The supervisor hands a beneficiary message to the beneficiary assistant and anything else to the investment
// assistant, then repeats what the assistant said; when the assistant asked for a confirmation, the customer's
// "yes" or "no" goes back with confirmed set. The specialized agents pick a tool from the request's words and
// answer with the tool's result.
using System.Text.RegularExpressions;

namespace WealthManagement.Tests;

public static partial class Scripts
{
    private static Step Say(string text) => new Say(text);

    private static Step Call(string name, Dictionary<string, object?>? args = null) => new Call(name, args ?? []);

    private static string Last(ScriptedRequest r) => r.ResultsThisTurn[^1];

    [GeneratedRegex(@"Workflow ID: (\S+)")]
    private static partial Regex WorkflowIdIn();

    /** The workflow ID of the latest account opening this agent started. */
    public static string? LatestOpening(ScriptedRequest r) =>
        r.AllResults.SelectMany(x => WorkflowIdIn().Matches(x).Select(m => m.Groups[1].Value)).LastOrDefault();

    private static Step Supervisor(ScriptedRequest r)
    {
        if (r.ResultsThisTurn.Count > 0) return Say(Last(r));
        var tool = Regex.IsMatch(r.LastUserText, "beneficiar|delete", RegexOptions.IgnoreCase) ? "beneficiary_assistant" : "investment_assistant";
        var args = new Dictionary<string, object?> { ["client_id"] = "123", ["request"] = r.LastUserText };
        var asked = r.AllResults.Count > 0 && r.AllResults[^1].Contains("needs the customer's confirmation");
        if (asked && Regex.IsMatch(r.LastUserText, @"^\s*yes", RegexOptions.IgnoreCase)) args["confirmed"] = true;
        if (asked && Regex.IsMatch(r.LastUserText, @"^\s*no\b", RegexOptions.IgnoreCase)) args["confirmed"] = false;
        // A yes or no to a confirmation goes to the agent that asked
        if (asked && args.ContainsKey("confirmed") && r.AllResults[^1].Contains("investment ID")) tool = "investment_assistant";
        if (asked && args.ContainsKey("confirmed") && r.AllResults[^1].Contains("beneficiary ID")) tool = "beneficiary_assistant";
        return Call(tool, args);
    }

    private static Step Beneficiary(ScriptedRequest r)
    {
        if (r.ResultsThisTurn.Count > 0) return Say(Last(r));
        if (Regex.IsMatch(r.LastUserText, @"\bdelete\b", RegexOptions.IgnoreCase))
        {
            return Call("delete_beneficiary", new() { ["client_id"] = "123", ["beneficiary_id"] = "b-1b011a72" });
        }
        return Call("list_beneficiaries", new() { ["client_id"] = "123" });
    }

    private static Step Investment(ScriptedRequest r)
    {
        if (r.ResultsThisTurn.Count > 0) return Say(Last(r));
        var text = r.LastUserText;
        if (Regex.IsMatch(text, @"\bclose\b", RegexOptions.IgnoreCase))
        {
            return Call("close_investment", new() { ["client_id"] = "123", ["investment_id"] = "i-1" });
        }
        if (Regex.IsMatch(text, "open|yes", RegexOptions.IgnoreCase))
        {
            return Call("open_account_assistant", new() { ["client_id"] = "123", ["request"] = text });
        }
        return Call("list_investments", new() { ["client_id"] = "123" });
    }

    /**
     * The open-account agent: starts an opening, shows the details, and approves KYC when the customer says yes.
     * With eager, it also tries to approve KYC in the turn it shows the details, which the KYC guard refuses.
     */
    public static Step OpenAccount(ScriptedRequest r, bool eager = false)
    {
        var results = r.ResultsThisTurn;
        var opening = LatestOpening(r);
        var open = Regex.Match(r.LastUserText, @"Open (\w+) with \$([\d,]+)");
        if (open.Success)
        {
            if (results.Count == 0)
            {
                return Call("open_new_investment_account", new()
                {
                    ["client_id"] = "123",
                    ["account_name"] = open.Groups[1].Value,
                    ["initial_amount"] = double.Parse(open.Groups[2].Value.Replace(",", "")),
                });
            }
            if (results.Count == 1 && results[0].Contains("Workflow ID")) return Call("get_current_client_info", new() { ["workflow_id"] = opening });
            if (results.Count == 2 && eager) return Call("approve_kyc", new() { ["workflow_id"] = opening });
            return Say(string.Join("\n", results));
        }
        if (Regex.IsMatch(r.LastUserText, "yes", RegexOptions.IgnoreCase) && opening != null)
        {
            return results.Count == 0 ? Call("approve_kyc", new() { ["workflow_id"] = opening }) : Say(Last(r));
        }
        if (Regex.IsMatch(r.LastUserText, "status", RegexOptions.IgnoreCase) && opening != null)
        {
            return results.Count == 0 ? Call("get_account_opening_status", new() { ["workflow_id"] = opening }) : Say(Last(r));
        }
        return Say("What would you like to name the account?");
    }

    /** Every agent, with the open-account agent as OpenAccount(r, eager). */
    public static Func<ScriptedRequest, Step> Demo(bool eager = false) => r => r.Agent switch
    {
        AgentKind.Supervisor => Supervisor(r),
        AgentKind.Beneficiary => Beneficiary(r),
        AgentKind.Investment => Investment(r),
        AgentKind.OpenAccount => OpenAccount(r, eager),
        _ => Say("Hello"),
    };
}
