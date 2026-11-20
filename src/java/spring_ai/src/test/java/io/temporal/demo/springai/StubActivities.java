package io.temporal.demo.springai;

import io.temporal.demo.springai.activities.WealthActivities;
import io.temporal.demo.springai.model.Beneficiary;
import io.temporal.demo.springai.model.BeneficiaryRecord;
import io.temporal.demo.springai.model.ChatInteraction;
import io.temporal.demo.springai.model.InvestmentAccount;
import io.temporal.demo.springai.model.InvestmentRecord;
import io.temporal.demo.springai.model.StatusUpdate;
import io.temporal.demo.springai.model.Transfer;
import io.temporal.demo.springai.model.WealthManagementClient;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

/** Activities for tests: each test overrides the ones it needs; the event stream ones record what they get. */
public class StubActivities implements WealthActivities {
    public final List<ChatInteraction> interactions = new CopyOnWriteArrayList<>();
    public final List<String> statuses = new CopyOnWriteArrayList<>();

    static UnsupportedOperationException notStubbed() {
        return new UnsupportedOperationException("not stubbed");
    }

    @Override public List<BeneficiaryRecord> listBeneficiaries(String clientId) { throw notStubbed(); }
    @Override public void addBeneficiary(Beneficiary beneficiary) { throw notStubbed(); }
    @Override public void deleteBeneficiary(String clientId, String beneficiaryId) { throw notStubbed(); }
    @Override public List<InvestmentRecord> listInvestments(String clientId) { throw notStubbed(); }
    @Override public void closeInvestment(String clientId, String investmentId) { throw notStubbed(); }
    @Override public void validateNewAccount(String clientId, String accountName, double initialAmount) { throw notStubbed(); }
    @Override public String findPromotion(String clientId) { throw notStubbed(); }
    @Override public InvestmentRecord openInvestment(InvestmentAccount account) { throw notStubbed(); }
    @Override public boolean removeInvestment(String clientId, String investmentId) { throw notStubbed(); }
    @Override public WealthManagementClient getClient(String clientId) { throw notStubbed(); }
    @Override public String updateClient(String clientId, Map<String, Object> fields) { throw notStubbed(); }
    @Override public Transfer debitLinkedAccount(String clientId, double amount, String transferId) { throw notStubbed(); }
    @Override public Transfer creditLinkedAccount(String clientId, double amount, String transferId) { throw notStubbed(); }
    @Override public String registerAccount(String clientId, String investmentId, double amount) { throw notStubbed(); }
    @Override public WealthManagementClient getCurrentClientInfo(String workflowId) { throw notStubbed(); }
    @Override public void approveKyc(String workflowId) { throw notStubbed(); }
    @Override public String updateClientDetails(String workflowId, Map<String, Object> fields) { throw notStubbed(); }

    @Override
    public long appendChatInteraction(String workflowId, ChatInteraction interaction) {
        interactions.add(interaction);
        return interactions.size();
    }

    @Override
    public long appendStatusUpdate(String workflowId, StatusUpdate update) {
        statuses.add(update.status());
        return statuses.size();
    }

    @Override
    public boolean deleteConversation(String workflowId) {
        return false;
    }
}
