package io.temporal.demo.springai;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.temporal.demo.springai.common.DataStore;
import io.temporal.demo.springai.common.Money;
import io.temporal.demo.springai.common.Session;
import io.temporal.demo.springai.common.TaskQueues;
import io.temporal.demo.springai.model.Beneficiary;
import io.temporal.demo.springai.model.BeneficiaryRecord;
import io.temporal.demo.springai.model.InvestmentAccount;
import io.temporal.demo.springai.model.InvestmentRecord;
import io.temporal.demo.springai.model.Transfer;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The Java versions of the shared pieces: the data store, sessions, money and the task queue rule. */
class CommonTest {
    // A copy of the committed data/ files (src/test/resources/data), so the tests never use data/ itself
    static Path seed(String name) {
        try {
            return Path.of(CommonTest.class.getResource("/data/" + name).toURI());
        } catch (java.net.URISyntaxException e) {
            throw new IllegalStateException(e);
        }
    }

    @TempDir
    Path dir;
    DataStore data;

    @BeforeEach
    void copySeed() throws IOException {
        for (String name : List.of("clients", "beneficiaries", "investments", "funding_accounts")) {
            Files.copy(seed(name + ".json"), dir.resolve(name + ".json"));
        }
        data = new DataStore(dir, null);
    }

    @Test
    void addingAndDeletingKeepsTheFilesExactlyAsPythonWritesThem() throws IOException {
        String beneficiaries = Files.readString(dir.resolve("beneficiaries.json"));
        String investments = Files.readString(dir.resolve("investments.json"));
        BeneficiaryRecord added = data.addBeneficiary(new Beneficiary("123", "Jo", "Doe", "niece"));
        assertTrue(data.listBeneficiaries("123").contains(added));
        assertTrue(data.deleteBeneficiary("123", added.beneficiaryId()));
        InvestmentRecord account = data.addInvestment(new InvestmentAccount("123", "Boat", 500.0));
        assertTrue(data.deleteInvestment("123", account.investmentId()));
        assertEquals(beneficiaries.strip(), Files.readString(dir.resolve("beneficiaries.json")).strip());
        assertEquals(investments.strip(), Files.readString(dir.resolve("investments.json")).strip());
    }

    @Test
    void transfersAreIdempotentAndCantOverdraw() {
        Transfer first = data.debit("123", 1000.0, "t-1");
        Transfer again = data.debit("123", 1000.0, "t-1");
        assertEquals(first, again);
        assertEquals(249000.0, first.balanceAfter());
        assertThrows(DataStore.InsufficientFundsException.class, () -> data.debit("123", 1_000_000.0, "t-2"));
        assertEquals(250000.0, data.credit("123", 1000.0, "t-1-refund").balanceAfter());
    }

    @Test
    void updatingAClientChangesOnlyItsKnownFields() {
        assertEquals("Client information successfully updated",
                data.updateClient("123", Map.of("last_name", "Doenut", "client_id", "999")));
        assertEquals("Doenut", data.getClient("123").lastName());
        assertEquals("Client 0 not found", data.updateClient("0", Map.of("last_name", "X")));
    }

    @Test
    void theSessionComesFromTheWorkflowId() {
        String session = "0123456789abcdef0123456789abcdef";
        assertEquals(session, Session.fromWorkflowId("springai-temporal-agent-session-" + session + "-chat-0011223344556677"));
        assertEquals(session, Session.fromWorkflowId("OpenAccount-springai-temporal-agent-session-" + session
                + "-chat-0011223344556677-123-Car-1"));
        assertEquals(Session.DEFAULT, Session.fromWorkflowId("smoke-1"));
        assertEquals(Session.DEFAULT, Session.current());
    }

    @Test
    void moneyAndTheOpenAccountQueue() {
        assertEquals("$1,234.50", Money.format(1234.5));
        assertEquals("-$0.05", Money.format(-0.05));
        assertEquals("Q", TaskQueues.openAccount("Q", null));
        assertEquals("Q-open-account", TaskQueues.openAccount("Q", "Java"));
        assertEquals("Other", TaskQueues.openAccount("Q", " Other "));
        assertFalse(DataStore.redisKey("s", "investments").isEmpty());
    }
}
