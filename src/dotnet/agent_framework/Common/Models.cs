// The records the workflows, activities and the data files share. Their JSON names are snake_case, as in every
// other framework, so the API, the web UI and the Java open-account worker read and write the same payloads.
using System.Text.Json.Serialization;

namespace WealthManagement.Common;

public sealed record Beneficiary(
    [property: JsonPropertyName("beneficiary_id")] string BeneficiaryId,
    [property: JsonPropertyName("first_name")] string FirstName,
    [property: JsonPropertyName("last_name")] string LastName,
    [property: JsonPropertyName("relationship")] string Relationship);

/** A new beneficiary: the add_beneficiary activity's input. */
public sealed record NewBeneficiary(
    [property: JsonPropertyName("client_id")] string ClientId,
    [property: JsonPropertyName("first_name")] string FirstName,
    [property: JsonPropertyName("last_name")] string LastName,
    [property: JsonPropertyName("relationship")] string Relationship);

/** An investment account as stored. */
public sealed record InvestmentRecord(
    [property: JsonPropertyName("investment_id")] string InvestmentId,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("balance")] double Balance);

/** A new investment account: the open_investment activity's input. */
public sealed record InvestmentAccount(
    [property: JsonPropertyName("client_id")] string ClientId,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("balance")] double Balance);

/** A transfer to or from a client's linked bank account. */
public sealed record Transfer(
    [property: JsonPropertyName("client_id")] string ClientId,
    [property: JsonPropertyName("amount")] double Amount,
    [property: JsonPropertyName("balance_after")] double BalanceAfter);

/** A client's details, shown to the customer for KYC. */
public sealed record WealthManagementClient(
    [property: JsonPropertyName("first_name")] string? FirstName,
    [property: JsonPropertyName("last_name")] string? LastName,
    [property: JsonPropertyName("address")] string? Address,
    [property: JsonPropertyName("phone")] string? Phone,
    [property: JsonPropertyName("email")] string? Email,
    [property: JsonPropertyName("marital_status")] string? MaritalStatus)
{
    /** The fields a customer can change, by their JSON names. */
    public static readonly IReadOnlyList<string> Fields =
        ["first_name", "last_name", "address", "phone", "email", "marital_status"];

    /** A copy with the given fields (by JSON name) changed. */
    public WealthManagementClient With(IReadOnlyDictionary<string, string> fields) => new(
        fields.GetValueOrDefault("first_name", FirstName ?? ""),
        fields.GetValueOrDefault("last_name", LastName ?? ""),
        fields.GetValueOrDefault("address", Address ?? ""),
        fields.GetValueOrDefault("phone", Phone ?? ""),
        fields.GetValueOrDefault("email", Email ?? ""),
        fields.GetValueOrDefault("marital_status", MaritalStatus ?? ""));
}

public sealed record ProcessUserMessageInput([property: JsonPropertyName("user_input")] string UserInput);

/** Sent by an open-account workflow to its parent chat on every state change. */
public sealed record UpdateAccountOpeningStateInput(
    [property: JsonPropertyName("account_name")] string AccountName,
    [property: JsonPropertyName("state")] string State,
    [property: JsonPropertyName("workflow_id")] string? WorkflowId);

/** One customer message and the agents' answer, as the web UI shows it. */
public sealed record ChatInteraction(
    [property: JsonPropertyName("user_prompt")] string UserPrompt,
    [property: JsonPropertyName("text_response")] string TextResponse,
    [property: JsonPropertyName("json_response")] string JsonResponse,
    [property: JsonPropertyName("agent_trace")] string AgentTrace);

public sealed record StatusUpdate([property: JsonPropertyName("status")] string Status);

public sealed record OpenInvestmentAccountInput(
    [property: JsonPropertyName("client_id")] string ClientId,
    [property: JsonPropertyName("account_name")] string AccountName,
    [property: JsonPropertyName("initial_amount")] double InitialAmount,
    [property: JsonPropertyName("promo_code")] string? PromoCode);

public sealed record OpenInvestmentAccountOutput(
    [property: JsonPropertyName("account_created")] bool AccountCreated,
    [property: JsonPropertyName("message")] string Message);
