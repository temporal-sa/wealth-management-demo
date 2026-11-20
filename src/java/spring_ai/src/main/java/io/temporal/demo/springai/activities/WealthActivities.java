package io.temporal.demo.springai.activities;

import io.temporal.activity.ActivityInterface;
import io.temporal.activity.ActivityMethod;
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

/**
 * Every activity, under the snake_case names of the shared Temporal contract. The other frameworks' scripts
 * and the Java open-account worker call them by these names.
 */
@ActivityInterface
public interface WealthActivities {
    // Business-rule failures: non-retryable application failures of these types
    String DEPOSIT_BELOW_MINIMUM = "DepositBelowMinimum";
    String DEPOSIT_LIMIT_EXCEEDED = "DepositLimitExceeded";
    String INSUFFICIENT_FUNDS = "InsufficientFunds";
    String CUSTODIAN_REJECTED = "CustodianRejected";

    double MIN_INITIAL_DEPOSIT = 100.0;
    double MAX_INITIAL_DEPOSIT = 1_000_000.0;
    String WELCOME_BONUS_PROMO = "WELCOME-BONUS";

    @ActivityMethod(name = "list_beneficiaries")
    List<BeneficiaryRecord> listBeneficiaries(String clientId);

    @ActivityMethod(name = "add_beneficiary")
    void addBeneficiary(Beneficiary beneficiary);

    @ActivityMethod(name = "delete_beneficiary")
    void deleteBeneficiary(String clientId, String beneficiaryId);

    @ActivityMethod(name = "list_investments")
    List<InvestmentRecord> listInvestments(String clientId);

    @ActivityMethod(name = "close_investment")
    void closeInvestment(String clientId, String investmentId);

    /** Checks the business rules for a new account: a broken rule fails non-retryably, on the first attempt. */
    @ActivityMethod(name = "validate_new_account")
    void validateNewAccount(String clientId, String accountName, double initialAmount);

    /** The promo code for a new account while a promotion runs (the chaos panel's "Bug in workflow code"). */
    @ActivityMethod(name = "find_promotion")
    String findPromotion(String clientId);

    @ActivityMethod(name = "open_investment")
    InvestmentRecord openInvestment(InvestmentAccount account);

    /** The saga's compensation for open_investment. An account that is already gone counts as removed. */
    @ActivityMethod(name = "remove_investment")
    boolean removeInvestment(String clientId, String investmentId);

    @ActivityMethod(name = "get_client")
    WealthManagementClient getClient(String clientId);

    @ActivityMethod(name = "update_client")
    String updateClient(String clientId, Map<String, Object> fields);

    @ActivityMethod(name = "debit_linked_account")
    Transfer debitLinkedAccount(String clientId, double amount, String transferId);

    /** The saga's compensation for debit_linked_account. */
    @ActivityMethod(name = "credit_linked_account")
    Transfer creditLinkedAccount(String clientId, double amount, String transferId);

    /** Registers a new account with the custodian, which holds its assets, and returns its reference. */
    @ActivityMethod(name = "register_account")
    String registerAccount(String clientId, String investmentId, double amount);

    /** The customer's details held by an account opening, through its get_client_details update. */
    @ActivityMethod(name = "get_current_client_info")
    WealthManagementClient getCurrentClientInfo(String workflowId);

    /** Tells an account opening that the customer confirmed their details (its verify_kyc signal). */
    @ActivityMethod(name = "approve_kyc")
    void approveKyc(String workflowId);

    /** Saves changed details through an account opening's update_client_details update, which completes KYC. */
    @ActivityMethod(name = "update_client_details")
    String updateClientDetails(String workflowId, Map<String, Object> fields);

    @ActivityMethod(name = "append_chat_interaction")
    long appendChatInteraction(String workflowId, ChatInteraction interaction);

    @ActivityMethod(name = "append_status_update")
    long appendStatusUpdate(String workflowId, StatusUpdate update);

    @ActivityMethod(name = "delete_conversation")
    boolean deleteConversation(String workflowId);
}
