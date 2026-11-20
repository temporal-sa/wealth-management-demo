package io.temporal.demo.springai.common;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.temporal.demo.springai.model.Beneficiary;
import io.temporal.demo.springai.model.BeneficiaryRecord;
import io.temporal.demo.springai.model.InvestmentAccount;
import io.temporal.demo.springai.model.InvestmentRecord;
import io.temporal.demo.springai.model.Transfer;
import io.temporal.demo.springai.model.WealthManagementClient;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.data.redis.core.StringRedisTemplate;

/**
 * The demo's system of record: the JSON files in data/ (beneficiaries.json, clients.json,
 * funding_accounts.json and investments.json).
 *
 * <p>DEMO_DATA_STORE=file (the default) reads and writes the files themselves. DEMO_DATA_STORE=redis keeps one
 * copy of each file per browser session (see {@link Session}) in Redis under {@code data:<session>:<name>}:
 * a session's first read starts from the file, its writes never touch the file, and its copy expires a day
 * after its last change. The other frameworks use the same keys and format (src/python/common/data_store.py).
 *
 * <p>Files are read and written as JSON trees, so fields this class doesn't know about are kept, and written in
 * the same style as the Python frameworks (4-space indents for clients and beneficiaries, 2 for the others).
 */
public class DataStore {
    public static final Set<String> CLIENT_FIELDS =
            Set.of("first_name", "last_name", "address", "phone", "email", "marital_status");
    private static final SecureRandom RANDOM = new SecureRandom();

    private final Path dir;
    private final StringRedisTemplate redis; // null: the files themselves

    public DataStore(Path dir, StringRedisTemplate redis) {
        this.dir = dir;
        this.redis = redis;
    }

    /** Whether DEMO_DATA_STORE asks for the Redis store ("redis", in any case). */
    public static boolean useRedis() {
        String value = System.getenv("DEMO_DATA_STORE");
        return value != null && value.trim().equalsIgnoreCase("redis");
    }

    public static String redisKey(String session, String name) {
        return "data:" + session + ":" + name;
    }

    /** DATA_DIR if it is set, otherwise the first data/ folder holding clients.json in the working directory or above. */
    public static Path findDataDir() {
        String env = System.getenv("DATA_DIR");
        if (env != null && !env.isBlank()) {
            return Path.of(env);
        }
        Path start = Path.of("").toAbsolutePath();
        for (Path d = start; d != null; d = d.getParent()) {
            if (Files.exists(d.resolve("data").resolve("clients.json"))) {
                return d.resolve("data");
            }
        }
        throw new IllegalStateException("No data/clients.json in " + start + " or above it; set DATA_DIR.");
    }

    /** A transfer the linked bank account can't cover: a business-rule failure. */
    public static class InsufficientFundsException extends RuntimeException {
        public InsufficientFundsException(String message) {
            super(message);
        }
    }

    // ---- Beneficiaries

    public synchronized List<BeneficiaryRecord> listBeneficiaries(String clientId) {
        return records(load("beneficiaries").get(clientId), BeneficiaryRecord.class);
    }

    public synchronized BeneficiaryRecord addBeneficiary(Beneficiary b) {
        ObjectNode data = load("beneficiaries");
        ArrayNode list = data.withArray(b.clientId());
        String id = newId("b-", ids(list, "beneficiary_id"));
        BeneficiaryRecord record = new BeneficiaryRecord(id, b.firstName(), b.lastName(), b.relationship());
        list.add(Json.MAPPER.valueToTree(record));
        save("beneficiaries", data, 4);
        return record;
    }

    public synchronized boolean deleteBeneficiary(String clientId, String beneficiaryId) {
        ObjectNode data = load("beneficiaries");
        boolean removed = removeById(data, clientId, "beneficiary_id", beneficiaryId, false);
        if (removed) {
            save("beneficiaries", data, 4);
        }
        return removed;
    }

    // ---- Clients

    public synchronized WealthManagementClient getClient(String clientId) {
        JsonNode client = load("clients").get(clientId);
        return client == null ? null : Json.MAPPER.convertValue(client, WealthManagementClient.class);
    }

    /** Changes the given fields of a client's details; returns a message saying what happened, as the others do. */
    public synchronized String updateClient(String clientId, Map<String, Object> fields) {
        ObjectNode data = load("clients");
        JsonNode client = data.get(clientId);
        if (!(client instanceof ObjectNode node)) {
            return "Client " + clientId + " not found";
        }
        fields.forEach((name, value) -> {
            if (value != null && CLIENT_FIELDS.contains(name)) {
                node.put(name, String.valueOf(value));
            }
        });
        save("clients", data, 4);
        return "Client information successfully updated";
    }

    // ---- Investments

    public synchronized List<InvestmentRecord> listInvestments(String clientId) {
        return records(load("investments").get(clientId), InvestmentRecord.class);
    }

    public synchronized InvestmentRecord addInvestment(InvestmentAccount account) {
        if (account.balance() < 0) {
            throw new IllegalArgumentException("balance must not be negative");
        }
        ObjectNode data = load("investments");
        ArrayNode list = data.withArray(account.clientId());
        String id = newId("i-", ids(list, "investment_id"));
        InvestmentRecord record = new InvestmentRecord(id, account.name(), account.balance());
        list.add(Json.MAPPER.valueToTree(record));
        save("investments", data, 2);
        return record;
    }

    public synchronized boolean deleteInvestment(String clientId, String investmentId) {
        ObjectNode data = load("investments");
        boolean removed = removeById(data, clientId, "investment_id", investmentId, true);
        if (removed) {
            save("investments", data, 2);
        }
        return removed;
    }

    // ---- Funding: the client's linked external bank account. The transfer ID makes each transfer idempotent:
    // applying it again returns the first result and moves no money.

    public Transfer debit(String clientId, double amount, String transferId) {
        return applyTransfer(clientId, -amount, transferId);
    }

    public Transfer credit(String clientId, double amount, String transferId) {
        return applyTransfer(clientId, amount, transferId);
    }

    private synchronized Transfer applyTransfer(String clientId, double delta, String transferId) {
        ObjectNode data = load("funding_accounts");
        ObjectNode transfers = data.withObject("transfers");
        if (transfers.has(transferId)) {
            return Json.MAPPER.convertValue(transfers.get(transferId), Transfer.class);
        }
        JsonNode account = data.withObject("accounts").get(clientId);
        if (!(account instanceof ObjectNode acct)) {
            throw new IllegalStateException("no linked funding account for client " + clientId);
        }
        double balance = acct.path("balance").asDouble();
        if (delta < 0 && balance < -delta) {
            throw new InsufficientFundsException(acct.path("name").asText() + " has " + Money.format(balance)
                    + ", which is not enough to transfer " + Money.format(-delta));
        }
        double after = Money.round2(balance + delta);
        acct.put("balance", after);
        Transfer transfer = new Transfer(clientId, delta, after);
        transfers.set(transferId, Json.MAPPER.valueToTree(transfer));
        save("funding_accounts", data, 2);
        return transfer;
    }

    // ---- Helpers

    private ObjectNode load(String name) {
        try {
            if (redis != null) {
                String raw = redis.opsForValue().get(redisKey(Session.current(), name));
                if (raw != null) {
                    return (ObjectNode) Json.MAPPER.readTree(raw);
                }
                // The session hasn't changed this file yet: start from the file.
            }
            Path file = dir.resolve(name + ".json");
            if (!Files.exists(file) || Files.size(file) == 0) {
                return Json.MAPPER.createObjectNode();
            }
            return (ObjectNode) Json.MAPPER.readTree(Files.readString(file, StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private void save(String name, ObjectNode data, int indent) {
        if (redis != null) {
            redis.opsForValue().set(redisKey(Session.current(), name), Json.compact(data), Session.TTL);
            return;
        }
        try {
            Files.writeString(dir.resolve(name + ".json"), Json.pretty(data, indent), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private static <T> List<T> records(JsonNode list, Class<T> type) {
        List<T> out = new ArrayList<>();
        if (list != null) {
            list.forEach(item -> out.add(Json.MAPPER.convertValue(item, type)));
        }
        return out;
    }

    private static List<String> ids(ArrayNode list, String field) {
        List<String> ids = new ArrayList<>();
        list.forEach(item -> ids.add(item.path(field).asText()));
        return ids;
    }

    private static boolean removeById(ObjectNode data, String clientId, String field, String id, boolean dropEmpty) {
        JsonNode list = data.get(clientId);
        if (!(list instanceof ArrayNode array)) {
            return false;
        }
        ArrayNode kept = Json.MAPPER.createArrayNode();
        array.forEach(item -> {
            if (!id.equals(item.path(field).asText())) {
                kept.add(item);
            }
        });
        if (kept.size() == array.size()) {
            return false;
        }
        if (dropEmpty && kept.isEmpty()) {
            data.remove(clientId);
        } else {
            data.set(clientId, kept);
        }
        return true;
    }

    private static String newId(String prefix, List<String> existing) {
        String id;
        do {
            byte[] b = new byte[4];
            RANDOM.nextBytes(b);
            id = prefix + HexFormat.of().formatHex(b);
        } while (existing.contains(id));
        return id;
    }
}
