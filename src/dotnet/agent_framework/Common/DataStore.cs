using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using StackExchange.Redis;

namespace WealthManagement.Common;

/** A transfer the linked bank account can't cover: a business-rule failure. */
public sealed class InsufficientFundsException(string message) : Exception(message);

/**
 * The demo's system of record: the JSON files in data/ (beneficiaries.json, clients.json, funding_accounts.json
 * and investments.json).
 *
 * DEMO_DATA_STORE=file (the default) reads and writes the files themselves. DEMO_DATA_STORE=redis keeps one copy
 * of each file per browser session (see Session) in Redis under data:<session>:<name>: a session's first read
 * starts from the file, its writes never touch the file, and its copy expires a day after its last change. The
 * other frameworks use the same keys and format (src/python/common/data_store.py).
 *
 * Every call reads the data again and every change writes it back, so a `git checkout data/` takes effect with
 * no restart. Files are read and written as JSON trees, so fields this class doesn't know are kept, written in
 * the same style as the Python frameworks (4-space indents for clients and beneficiaries, 2 for the others).
 */
public sealed class DataStore(string dir, IDatabase? redis = null)
{
    private static readonly JsonSerializerOptions Pretty4 = new() { WriteIndented = true, IndentSize = 4, Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
    private static readonly JsonSerializerOptions Pretty2 = new() { WriteIndented = true, IndentSize = 2, Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
    private readonly object gate = new();
    // Encoding.UTF8 writes a byte-order mark, which the other languages' JSON readers (Python's json) refuse
    private static readonly UTF8Encoding Utf8NoBom = new(encoderShouldEmitUTF8Identifier: false);

    /** The store the environment asks for: DATA_DIR (or the repository's data/), and Redis with DEMO_DATA_STORE=redis. */
    public static DataStore FromEnvironment() =>
        new(FindDataDir(), UseRedis() ? RedisConfig.Database() : null);

    /** Whether DEMO_DATA_STORE asks for the Redis store ("redis", in any case). */
    public static bool UseRedis() => Env.Get("DEMO_DATA_STORE").Equals("redis", StringComparison.OrdinalIgnoreCase);

    public static string RedisKey(string session, string name) => $"data:{session}:{name}";

    /** DATA_DIR if it is set, otherwise the first data/ folder holding clients.json in the working directory or above. */
    public static string FindDataDir()
    {
        var env = Env.Get("DATA_DIR");
        if (env != "") return env;
        for (var d = new DirectoryInfo(Directory.GetCurrentDirectory()); d != null; d = d.Parent)
        {
            if (File.Exists(Path.Combine(d.FullName, "data", "clients.json"))) return Path.Combine(d.FullName, "data");
        }
        throw new InvalidOperationException($"No data/clients.json in {Directory.GetCurrentDirectory()} or above it; set DATA_DIR.");
    }

    // ---- Beneficiaries

    public List<Beneficiary> ListBeneficiaries(string clientId)
    {
        lock (gate) return Records<Beneficiary>(Load("beneficiaries")[clientId]);
    }

    public Beneficiary AddBeneficiary(NewBeneficiary b)
    {
        lock (gate)
        {
            var data = Load("beneficiaries");
            var list = ArrayFor(data, b.ClientId);
            var record = new Beneficiary(NewId("b-", Ids(list, "beneficiary_id")), b.FirstName, b.LastName, b.Relationship);
            list.Add(JsonSerializer.SerializeToNode(record));
            Save("beneficiaries", data, 4);
            return record;
        }
    }

    public bool DeleteBeneficiary(string clientId, string beneficiaryId)
    {
        lock (gate)
        {
            var data = Load("beneficiaries");
            if (!RemoveById(data, clientId, "beneficiary_id", beneficiaryId, dropEmpty: false)) return false;
            Save("beneficiaries", data, 4);
            return true;
        }
    }

    // ---- Clients

    public WealthManagementClient? GetClient(string clientId)
    {
        lock (gate) return Load("clients")[clientId]?.Deserialize<WealthManagementClient>();
    }

    /** Changes the given fields of a client's details; returns a message saying what happened, as the others do. */
    public string UpdateClient(string clientId, IReadOnlyDictionary<string, string> fields)
    {
        lock (gate)
        {
            var data = Load("clients");
            if (data[clientId] is not JsonObject client) return $"Client {clientId} not found";
            foreach (var (name, value) in fields)
            {
                if (WealthManagementClient.Fields.Contains(name)) client[name] = value;
            }
            Save("clients", data, 4);
            return "Client information successfully updated";
        }
    }

    // ---- Investments

    public List<InvestmentRecord> ListInvestments(string clientId)
    {
        lock (gate) return Records<InvestmentRecord>(Load("investments")[clientId]);
    }

    public InvestmentRecord AddInvestment(InvestmentAccount account)
    {
        if (account.Balance < 0) throw new ArgumentException("balance must not be negative");
        lock (gate)
        {
            var data = Load("investments");
            var list = ArrayFor(data, account.ClientId);
            var record = new InvestmentRecord(NewId("i-", Ids(list, "investment_id")), account.Name, account.Balance);
            list.Add(JsonSerializer.SerializeToNode(record));
            Save("investments", data, 2);
            return record;
        }
    }

    public bool DeleteInvestment(string clientId, string investmentId)
    {
        lock (gate)
        {
            var data = Load("investments");
            if (!RemoveById(data, clientId, "investment_id", investmentId, dropEmpty: true)) return false;
            Save("investments", data, 2);
            return true;
        }
    }

    // ---- Funding: the client's linked bank account. The transfer ID makes each transfer idempotent: applying it
    // again returns the first result and moves no money.

    public Transfer Debit(string clientId, double amount, string transferId) => ApplyTransfer(clientId, -amount, transferId);

    public Transfer Credit(string clientId, double amount, string transferId) => ApplyTransfer(clientId, amount, transferId);

    private Transfer ApplyTransfer(string clientId, double delta, string transferId)
    {
        lock (gate)
        {
            var data = Load("funding_accounts");
            var transfers = ObjectFor(data, "transfers");
            if (transfers[transferId] is { } done) return done.Deserialize<Transfer>()!;
            if (ObjectFor(data, "accounts")[clientId] is not JsonObject account)
            {
                throw new InvalidOperationException($"no linked funding account for client {clientId}");
            }
            var balance = account["balance"]?.GetValue<double>() ?? 0;
            if (delta < 0 && balance < -delta)
            {
                throw new InsufficientFundsException(
                    $"{account["name"]} has {Money.Format(balance)}, which is not enough to transfer {Money.Format(-delta)}");
            }
            var after = Money.Round2(balance + delta);
            account["balance"] = after;
            var transfer = new Transfer(clientId, delta, after);
            transfers[transferId] = JsonSerializer.SerializeToNode(transfer);
            Save("funding_accounts", data, 2);
            return transfer;
        }
    }

    // ---- Helpers

    private JsonObject Load(string name)
    {
        if (redis != null)
        {
            var raw = redis.StringGet(RedisKey(Session.Current(), name));
            if (raw.HasValue) return JsonNode.Parse(raw.ToString())!.AsObject();
            // The session hasn't changed this file yet: start from the file
        }
        var file = Path.Combine(dir, name + ".json");
        if (!File.Exists(file) || new FileInfo(file).Length == 0) return [];
        return JsonNode.Parse(File.ReadAllText(file, Encoding.UTF8))!.AsObject();
    }

    private void Save(string name, JsonObject data, int indent)
    {
        if (redis != null)
        {
            redis.StringSet(RedisKey(Session.Current(), name), data.ToJsonString(), Session.Ttl);
            return;
        }
        File.WriteAllText(Path.Combine(dir, name + ".json"), data.ToJsonString(indent == 4 ? Pretty4 : Pretty2), Utf8NoBom);
    }

    private static JsonArray ArrayFor(JsonObject data, string key)
    {
        if (data[key] is JsonArray a) return a;
        var created = new JsonArray();
        data[key] = created;
        return created;
    }

    private static JsonObject ObjectFor(JsonObject data, string key)
    {
        if (data[key] is JsonObject o) return o;
        var created = new JsonObject();
        data[key] = created;
        return created;
    }

    private static List<T> Records<T>(JsonNode? list) =>
        list is JsonArray a ? a.Select(item => item!.Deserialize<T>()!).ToList() : [];

    private static List<string> Ids(JsonArray list, string field) =>
        list.Select(item => item?[field]?.GetValue<string>() ?? "").ToList();

    private static bool RemoveById(JsonObject data, string clientId, string field, string id, bool dropEmpty)
    {
        if (data[clientId] is not JsonArray array) return false;
        var kept = new JsonArray();
        foreach (var item in array.ToList())
        {
            if (item?[field]?.GetValue<string>() != id) kept.Add(item?.DeepClone());
        }
        if (kept.Count == array.Count) return false;
        if (dropEmpty && kept.Count == 0) data.Remove(clientId);
        else data[clientId] = kept;
        return true;
    }

    private static string NewId(string prefix, List<string> existing)
    {
        string id;
        do id = prefix + Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(4));
        while (existing.Contains(id));
        return id;
    }
}
