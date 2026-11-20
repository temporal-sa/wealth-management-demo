package io.temporal.demo.springai.activities;

import io.temporal.client.WorkflowClient;
import io.temporal.client.WorkflowStub;
import io.temporal.demo.springai.common.Chaos;
import io.temporal.demo.springai.common.DataStore;
import io.temporal.demo.springai.common.EventStream;
import io.temporal.demo.springai.common.Money;
import io.temporal.demo.springai.model.Beneficiary;
import io.temporal.demo.springai.model.BeneficiaryRecord;
import io.temporal.demo.springai.model.ChatInteraction;
import io.temporal.demo.springai.model.InvestmentAccount;
import io.temporal.demo.springai.model.InvestmentRecord;
import io.temporal.demo.springai.model.StatusUpdate;
import io.temporal.demo.springai.model.Transfer;
import io.temporal.demo.springai.model.WealthManagementClient;
import io.temporal.failure.ApplicationFailure;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class WealthActivitiesImpl implements WealthActivities {
    private static final Logger log = LoggerFactory.getLogger(WealthActivitiesImpl.class);

    private final DataStore data;
    private final Chaos chaos;
    private final EventStream events;
    // Signals and updates account openings (get_current_client_info, approve_kyc, update_client_details)
    private final WorkflowClient client;

    public WealthActivitiesImpl(DataStore data, Chaos chaos, EventStream events, WorkflowClient client) {
        this.data = data;
        this.chaos = chaos;
        this.events = events;
        this.client = client;
    }

    // ---- Beneficiaries

    @Override
    public List<BeneficiaryRecord> listBeneficiaries(String clientId) {
        log.info("list_beneficiaries client_id={}", clientId);
        chaos.coreBankingApi();
        return data.listBeneficiaries(clientId);
    }

    @Override
    public void addBeneficiary(Beneficiary beneficiary) {
        log.info("add_beneficiary client_id={}", beneficiary.clientId());
        chaos.coreBankingApi();
        data.addBeneficiary(beneficiary);
    }

    @Override
    public void deleteBeneficiary(String clientId, String beneficiaryId) {
        log.info("delete_beneficiary client_id={} beneficiary_id={}", clientId, beneficiaryId);
        chaos.coreBankingApi();
        data.deleteBeneficiary(clientId, beneficiaryId);
    }

    // ---- Investments

    @Override
    public List<InvestmentRecord> listInvestments(String clientId) {
        log.info("list_investments client_id={}", clientId);
        chaos.coreBankingApi();
        return data.listInvestments(clientId);
    }

    @Override
    public void closeInvestment(String clientId, String investmentId) {
        log.info("close_investment client_id={} investment_id={}", clientId, investmentId);
        chaos.coreBankingApi();
        data.deleteInvestment(clientId, investmentId);
    }

    @Override
    public void validateNewAccount(String clientId, String accountName, double initialAmount) {
        log.info("validate_new_account client_id={} account_name={} initial_amount={}", clientId, accountName, initialAmount);
        checkDeposit(initialAmount);
    }

    /** The deposit rules: from $100 to $1,000,000. */
    public static void checkDeposit(double initialAmount) {
        if (initialAmount < MIN_INITIAL_DEPOSIT) {
            throw ApplicationFailure.newNonRetryableFailure(
                    "The initial deposit must be at least " + Money.format(MIN_INITIAL_DEPOSIT), DEPOSIT_BELOW_MINIMUM);
        }
        if (initialAmount > MAX_INITIAL_DEPOSIT) {
            throw ApplicationFailure.newNonRetryableFailure("Initial deposits over " + Money.format(MAX_INITIAL_DEPOSIT)
                    + " cannot be opened online and must be arranged with a wealth advisor", DEPOSIT_LIMIT_EXCEEDED);
        }
    }

    @Override
    public String findPromotion(String clientId) {
        log.info("find_promotion client_id={}", clientId);
        return chaos.isEnabled(Chaos.WORKFLOW_BUG) ? WELCOME_BONUS_PROMO : null;
    }

    @Override
    public InvestmentRecord openInvestment(InvestmentAccount account) {
        log.info("open_investment client_id={} name={} balance={}", account.clientId(), account.name(), account.balance());
        chaos.maybeSlowDown();
        chaos.coreBankingApi();
        return data.addInvestment(account);
    }

    @Override
    public boolean removeInvestment(String clientId, String investmentId) {
        log.info("remove_investment client_id={} investment_id={}", clientId, investmentId);
        chaos.maybeSlowDown();
        chaos.coreBankingApi();
        data.deleteInvestment(clientId, investmentId);
        return true;
    }

    // ---- Clients

    @Override
    public WealthManagementClient getClient(String clientId) {
        log.info("get_client client_id={}", clientId);
        return data.getClient(clientId);
    }

    @Override
    public String updateClient(String clientId, Map<String, Object> fields) {
        log.info("update_client client_id={} fields={}", clientId, fields);
        return data.updateClient(clientId, fields);
    }

    // ---- Funding: each call carries a transfer ID that is stable across retries, so a retry never moves money twice

    @Override
    public Transfer debitLinkedAccount(String clientId, double amount, String transferId) {
        log.info("debit_linked_account client_id={} amount={} transfer_id={}", clientId, amount, transferId);
        chaos.maybeSlowDown();
        try {
            return data.debit(clientId, amount, transferId);
        } catch (DataStore.InsufficientFundsException e) {
            // A business-rule failure: retrying won't make the money appear
            throw ApplicationFailure.newNonRetryableFailure(e.getMessage(), INSUFFICIENT_FUNDS);
        }
    }

    @Override
    public Transfer creditLinkedAccount(String clientId, double amount, String transferId) {
        log.info("credit_linked_account client_id={} amount={} transfer_id={}", clientId, amount, transferId);
        chaos.maybeSlowDown();
        return data.credit(clientId, amount, transferId);
    }

    // ---- Custodian

    @Override
    public String registerAccount(String clientId, String investmentId, double amount) {
        log.info("register_account client_id={} investment_id={} amount={}", clientId, investmentId, amount);
        chaos.maybeSlowDown();
        chaos.inject(Chaos.CUSTODIAN_REJECTS, ApplicationFailure.newNonRetryableFailure(
                "The custodian rejected the account registration", CUSTODIAN_REJECTED));
        return "CUST-" + investmentId;
    }

    // ---- The chat side of an account opening: through the Temporal client

    @Override
    public WealthManagementClient getCurrentClientInfo(String workflowId) {
        return stub(workflowId).update("get_client_details", WealthManagementClient.class);
    }

    @Override
    public void approveKyc(String workflowId) {
        stub(workflowId).signal("verify_kyc");
    }

    @Override
    public String updateClientDetails(String workflowId, Map<String, Object> fields) {
        Map<String, Object> changed = new HashMap<>();
        fields.forEach((k, v) -> {
            if (v != null && !"client_id".equals(k)) {
                changed.put(k, v);
            }
        });
        return stub(workflowId).update("update_client_details", String.class, changed);
    }

    private WorkflowStub stub(String workflowId) {
        return client.newUntypedWorkflowStub(workflowId);
    }

    // ---- Event stream

    @Override
    public long appendChatInteraction(String workflowId, ChatInteraction interaction) {
        return events.append(workflowId, EventStream.CHAT_INTERACTION, interaction);
    }

    @Override
    public long appendStatusUpdate(String workflowId, StatusUpdate update) {
        return events.append(workflowId, EventStream.STATUS_UPDATE, update);
    }

    @Override
    public boolean deleteConversation(String workflowId) {
        return events.delete(workflowId);
    }
}
