package io.temporal.demo.springai.workflows;

import io.temporal.activity.ActivityOptions;
import io.temporal.demo.springai.activities.WealthActivities;
import io.temporal.demo.springai.common.RetryPolicies;
import io.temporal.demo.springai.model.InvestmentAccount;
import io.temporal.demo.springai.model.InvestmentRecord;
import io.temporal.demo.springai.model.OpenInvestmentAccountInput;
import io.temporal.demo.springai.model.OpenInvestmentAccountOutput;
import io.temporal.demo.springai.model.UpdateAccountOpeningStateInput;
import io.temporal.demo.springai.model.WealthManagementClient;
import io.temporal.failure.ActivityFailure;
import io.temporal.failure.ApplicationFailure;
import io.temporal.workflow.Saga;
import io.temporal.workflow.Workflow;
import java.time.Duration;
import java.util.Map;
import java.util.Optional;
import org.slf4j.Logger;

public class OpenInvestmentAccountWorkflowImpl implements OpenInvestmentAccountWorkflow {
    // Welcome-bonus promotion: a percentage of the initial deposit, up to MAX_BONUS.
    // *** Bug-In-Workflow-Code ***
    // Intentional bug for the "Bug in workflow code" demo: the promo code is "WELCOME-BONUS" (hyphen), but
    // BONUS_RATES is keyed by "WELCOME_BONUS" (underscore), so the lookup in welcomeBonus returns null and
    // unboxing it throws a NullPointerException. To fix it, uncomment the first line below and comment out the
    // second, then restart the worker. See the README, "Failure scenarios".
    // private static final Map<String, Double> BONUS_RATES = Map.of("WELCOME-BONUS", 0.01);
    private static final Map<String, Double> BONUS_RATES = Map.of("WELCOME_BONUS", 0.01);
    private static final double MAX_BONUS = 500.0;

    private final Logger log = Workflow.getLogger(OpenInvestmentAccountWorkflowImpl.class);
    // The activities run on this workflow's task queue. The timeout bounds one attempt only, so an outage is
    // retried for as long as it lasts.
    private final WealthActivities activities = Workflow.newActivityStub(WealthActivities.class,
            ActivityOptions.newBuilder().setStartToCloseTimeout(Duration.ofSeconds(30))
                    .setRetryOptions(RetryPolicies.TOOL).build());

    private OpenInvestmentAccountInput inputs;
    private WealthManagementClient client;
    private boolean initialized;
    private boolean kycVerified;
    private boolean complianceReviewed;
    private String currentState = "Initializing";

    @Override
    public OpenInvestmentAccountOutput run(OpenInvestmentAccountInput inputs) {
        log.info("Started workflow {}", inputs);
        this.inputs = inputs;
        this.client = activities.getClient(inputs.clientId());
        this.initialized = true;
        setState("Waiting KYC");

        // Wait until the customer has confirmed their details
        Workflow.await(() -> kycVerified);
        setState("Waiting Compliance Review");

        // Wait until compliance approves, from outside the chat
        Workflow.await(() -> complianceReviewed);
        setState("Compliance review has been approved. Creating Investment Account");
        return openAccount();
    }

    /**
     * Saga: create, fund and register the account. Each completed step registers how to undo it. If a later
     * step fails with a non-retryable error, the compensations run in reverse order. Transient failures never
     * get here: activities retry until they succeed.
     */
    private OpenInvestmentAccountOutput openAccount() {
        String clientId = inputs.clientId();
        double amount = inputs.initialAmount();
        double bonus = inputs.promoCode() != null ? welcomeBonus(inputs) : 0.0;
        // Idempotency key: stable across activity retries and worker restarts, and different for a workflow
        // started again with the same ID (the run ID)
        String transferId = Workflow.getInfo().getWorkflowId() + "-" + Workflow.getInfo().getRunId() + "-initial-deposit";

        Saga saga = new Saga(new Saga.Options.Builder().setParallelCompensation(false).build());
        try {
            setState("Creating the account record.");
            InvestmentRecord account = activities.openInvestment(
                    new InvestmentAccount(clientId, inputs.accountName(), amount + bonus));
            saga.addCompensation(() -> {
                setState("Rolling back: removing the account record.");
                activities.removeInvestment(clientId, account.investmentId());
            });

            setState(String.format("Transferring $%,.2f from the linked bank account.", amount));
            activities.debitLinkedAccount(clientId, amount, transferId);
            saga.addCompensation(() -> {
                setState(String.format("Rolling back: refunding $%,.2f to the linked bank account.", amount));
                activities.creditLinkedAccount(clientId, amount, transferId + "-refund");
            });

            setState("Registering the account with the custodian.");
            activities.registerAccount(clientId, account.investmentId(), amount);
        } catch (ActivityFailure e) {
            String reason = reason(e);
            setState("Failed: " + reason + ". Rolling back.");
            saga.compensate();
            setState("Rolled back. The account was not opened: " + reason + ".");
            return new OpenInvestmentAccountOutput(false, "The account was not opened: " + reason);
        }
        setState("Complete");
        return new OpenInvestmentAccountOutput(true, "investment account created");
    }

    private static double welcomeBonus(OpenInvestmentAccountInput inputs) {
        double rate = BONUS_RATES.get(inputs.promoCode());
        return Math.min(inputs.initialAmount() * rate, MAX_BONUS);
    }

    // The business reason for a non-retryable activity failure, such as the custodian rejecting the account
    private static String reason(ActivityFailure e) {
        Throwable cause = e.getCause();
        if (cause instanceof ApplicationFailure failure) {
            return failure.getOriginalMessage();
        }
        return cause != null ? cause.getMessage() : e.getMessage();
    }

    @Override
    public String getCurrentState() {
        return currentState;
    }

    @Override
    public WealthManagementClient getClientDetails() {
        Workflow.await(() -> initialized);
        return client;
    }

    @Override
    public String updateClientDetails(Map<String, Object> clientDetails) {
        String result = activities.updateClient(inputs.clientId(), clientDetails);
        kycVerified = true;
        return result;
    }

    @Override
    public void verifyKyc() {
        Workflow.await(() -> initialized);
        kycVerified = true;
    }

    @Override
    public void complianceApproved() {
        Workflow.await(() -> initialized && kycVerified);
        complianceReviewed = true;
    }

    private void setState(String state) {
        currentState = state;
        Optional<String> parent = Workflow.getInfo().getParentWorkflowId();
        if (parent.isPresent()) {
            Workflow.newUntypedExternalWorkflowStub(parent.get()).signal("update_account_opening_state",
                    new UpdateAccountOpeningStateInput(inputs.accountName(), state, Workflow.getInfo().getWorkflowId()));
        }
    }
}
