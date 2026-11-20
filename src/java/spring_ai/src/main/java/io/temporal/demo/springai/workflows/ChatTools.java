package io.temporal.demo.springai.workflows;

import io.temporal.activity.ActivityOptions;
import io.temporal.api.enums.v1.ParentClosePolicy;
import io.temporal.demo.springai.activities.WealthActivities;
import io.temporal.demo.springai.agents.TurnState;
import io.temporal.demo.springai.common.Json;
import io.temporal.demo.springai.common.RetryPolicies;
import io.temporal.demo.springai.model.Beneficiary;
import io.temporal.demo.springai.model.OpenInvestmentAccountInput;
import io.temporal.failure.ActivityFailure;
import io.temporal.failure.ApplicationFailure;
import io.temporal.workflow.Async;
import io.temporal.workflow.ChildWorkflowOptions;
import io.temporal.workflow.Workflow;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.ai.tool.annotation.Tool;
import org.springframework.ai.tool.annotation.ToolParam;

/**
 * The Temporal version's tools. They run in the chat workflow: Spring AI calls them on the workflow thread
 * (Temporal's Spring AI integration runs a plain {@code @Tool} method there), so they must be deterministic.
 * A tool that touches a system runs an activity, so an outage pauses the conversation instead of losing it;
 * open_new_investment_account starts the open-account child workflow; the account-opening tools read the
 * conversation's state, which signals update.
 *
 * <p>An activity failure (one that isn't retried, such as a business rule) goes back to the model as the
 * tool's output.
 */
public final class ChatTools {
    static final String CLIENT_ID = "The customer's client ID";
    static final String WORKFLOW_ID = "The workflow ID returned by open_new_investment_account";
    /** One attempt of a tool activity. Retries are unlimited, so an outage is waited out rather than timed out. */
    static final Duration TOOL_TIMEOUT = Duration.ofSeconds(5);

    private final TurnState state;
    private final WealthManagementContext context;
    private final String openAccountTaskQueue;
    private final WealthActivities activities = Workflow.newActivityStub(WealthActivities.class,
            ActivityOptions.newBuilder().setStartToCloseTimeout(TOOL_TIMEOUT).setRetryOptions(RetryPolicies.TOOL).build());

    public ChatTools(TurnState state, WealthManagementContext context, String openAccountTaskQueue) {
        this.state = state;
        this.context = context;
        this.openAccountTaskQueue = openAccountTaskQueue;
    }

    interface Call {
        Object run();
    }

    // Runs a tool's body: records the call and its output; an activity failure becomes the output
    private String run(String clientId, Call call) {
        state.toolCalled(clientId);
        String output;
        try {
            Object value = call.run();
            output = value == null ? "Done." : value instanceof String s ? s : Json.compact(value);
        } catch (ActivityFailure e) {
            Throwable cause = e.getCause();
            String reason = cause instanceof ApplicationFailure f ? f.getOriginalMessage() : String.valueOf(cause);
            output = "Error: " + reason;
        }
        return state.output(output);
    }

    public final BeneficiaryTools beneficiaryTools = new BeneficiaryTools();
    public final InvestmentTools investmentTools = new InvestmentTools();
    public final OpenAccountTools openAccountTools = new OpenAccountTools();

    public class BeneficiaryTools {
        @Tool(name = "list_beneficiaries", description = "List the beneficiaries for the given client ID.")
        public String listBeneficiaries(@ToolParam(description = CLIENT_ID) String client_id) {
            return run(client_id, () -> activities.listBeneficiaries(client_id));
        }

        @Tool(name = "add_beneficiary", description = "Add a beneficiary for the given client ID.")
        public String addBeneficiary(@ToolParam(description = CLIENT_ID) String client_id,
                @ToolParam(description = "The beneficiary's first name") String first_name,
                @ToolParam(description = "The beneficiary's last name") String last_name,
                @ToolParam(description = "The beneficiary's relationship to the customer, such as son or spouse") String relationship) {
            return run(client_id, () -> {
                activities.addBeneficiary(new Beneficiary(client_id, first_name, last_name, relationship));
                return "Beneficiary " + first_name + " " + last_name + " added.";
            });
        }

        @Tool(name = "delete_beneficiary", description = "Delete a beneficiary by its beneficiary ID.")
        public String deleteBeneficiary(@ToolParam(description = CLIENT_ID) String client_id,
                @ToolParam(description = "The beneficiary ID from list_beneficiaries") String beneficiary_id) {
            return run(client_id, () -> {
                activities.deleteBeneficiary(client_id, beneficiary_id);
                return "Beneficiary " + beneficiary_id + " deleted.";
            });
        }
    }

    public class InvestmentTools {
        @Tool(name = "list_investments", description = "List the investment accounts and balances for the given client ID.")
        public String listInvestments(@ToolParam(description = CLIENT_ID) String client_id) {
            return run(client_id, () -> activities.listInvestments(client_id));
        }

        @Tool(name = "close_investment", description = "Close an investment account by its investment ID.")
        public String closeInvestment(@ToolParam(description = CLIENT_ID) String client_id,
                @ToolParam(description = "The investment ID from list_investments") String investment_id) {
            return run(client_id, () -> {
                activities.closeInvestment(client_id, investment_id);
                return "Investment account " + investment_id + " closed.";
            });
        }
    }

    public class OpenAccountTools {
        @Tool(name = "open_new_investment_account", description = "Begin opening a new investment account. Returns the "
                + "workflow ID of the account opening, which the other open-account tools require, or the reason the "
                + "account cannot be opened.")
        public String openNewInvestmentAccount(@ToolParam(description = CLIENT_ID) String client_id,
                @ToolParam(description = "The name for the new investment account") String account_name,
                @ToolParam(description = "The initial deposit amount") double initial_amount) {
            return run(client_id, () -> {
                // Business rules first: a violation fails non-retryably, and the reason goes back to the agent
                try {
                    activities.validateNewAccount(client_id, account_name, initial_amount);
                } catch (ActivityFailure e) {
                    if (e.getCause() instanceof ApplicationFailure f) {
                        return "The account cannot be opened: " + f.getOriginalMessage();
                    }
                    throw e;
                }
                // Read in an activity, so it is recorded in history and replays the same
                String promoCode = activities.findPromotion(client_id);
                // Every request starts a new account opening, even for a name used earlier in the conversation.
                // The ID ends with the number of openings started in this chat, counting this one.
                int openingNumber = context.accountOpeningsStarted + 1;
                String childId = "OpenAccount-" + Workflow.getInfo().getWorkflowId() + "-" + client_id + "-"
                        + account_name + "-" + openingNumber;
                OpenInvestmentAccountWorkflow child = Workflow.newChildWorkflowStub(OpenInvestmentAccountWorkflow.class,
                        ChildWorkflowOptions.newBuilder().setWorkflowId(childId).setTaskQueue(openAccountTaskQueue)
                                .setParentClosePolicy(ParentClosePolicy.PARENT_CLOSE_POLICY_TERMINATE).build());
                Async.function(child::run, new OpenInvestmentAccountInput(client_id, account_name, initial_amount, promoCode));
                Workflow.getWorkflowExecution(child).get(); // started
                context.accountOpeningsStarted = openingNumber;
                context.accountOpeningRequests.put(childId, account_name + " with " + String.format("$%,.2f", initial_amount));
                // Known from the start, so a status check right away doesn't report "not found"
                context.accountOpeningStates.putIfAbsent(childId, "Initializing");
                return childId;
            });
        }

        @Tool(name = "get_account_opening_status", description = "Get the current status of an account opening. "
                + "\"Complete\" means the account was opened; a status starting with \"Rolled back\" means it was not "
                + "opened. Either way, that account opening is finished.")
        public String getAccountOpeningStatus(@ToolParam(description = WORKFLOW_ID) String workflow_id) {
            return run(null, () -> {
                String status = context.accountOpeningStates.get(workflow_id);
                return status != null ? status
                        : "No account opening with workflow ID " + workflow_id + " was found in this conversation.";
            });
        }

        @Tool(name = "get_current_client_info", description = "Retrieve the customer's current details for an account "
                + "opening, to show them for KYC.")
        public String getCurrentClientInfo(@ToolParam(description = WORKFLOW_ID) String workflow_id) {
            return run(null, () -> {
                Object client = activities.getCurrentClientInfo(workflow_id);
                context.kycDetailsShownTurn.put(workflow_id, context.turn);
                return client;
            });
        }

        @Tool(name = "approve_kyc", description = "Approve KYC for an account opening, after the customer confirmed "
                + "their details are correct.")
        public String approveKyc(@ToolParam(description = WORKFLOW_ID) String workflow_id) {
            return run(null, () -> {
                // The model sometimes treats a confirmation for an earlier account opening as approval for a new
                // one. Only approve once this opening's details have been shown and the customer replied since.
                Integer shown = context.kycDetailsShownTurn.get(workflow_id);
                if (shown == null || shown >= context.turn) {
                    return "KYC was not approved. First show the customer their current details for this account "
                            + "opening (get_current_client_info) and ask whether they are correct. Approve KYC only "
                            + "after the customer confirms in their next message.";
                }
                activities.approveKyc(workflow_id);
                return "KYC approved. The account is now waiting for compliance review.";
            });
        }

        @Tool(name = "update_client_details", description = "Update the customer's details for an account opening, "
                + "which completes KYC. Pass only the fields that changed.")
        public String updateClientDetails(@ToolParam(description = WORKFLOW_ID) String workflow_id,
                @ToolParam(required = false, description = "New first name") String first_name,
                @ToolParam(required = false, description = "New last name") String last_name,
                @ToolParam(required = false, description = "New address") String address,
                @ToolParam(required = false, description = "New phone number") String phone,
                @ToolParam(required = false, description = "New email address") String email,
                @ToolParam(required = false, description = "New marital status") String marital_status) {
            return run(null, () -> {
                Map<String, Object> changed = new LinkedHashMap<>();
                putIfSet(changed, "first_name", first_name);
                putIfSet(changed, "last_name", last_name);
                putIfSet(changed, "address", address);
                putIfSet(changed, "phone", phone);
                putIfSet(changed, "email", email);
                putIfSet(changed, "marital_status", marital_status);
                if (changed.isEmpty()) {
                    return "Nothing was updated: pass at least one changed field.";
                }
                return activities.updateClientDetails(workflow_id, changed);
            });
        }
    }

    private static void putIfSet(Map<String, Object> map, String key, String value) {
        if (value != null && !value.isBlank()) {
            map.put(key, value);
        }
    }
}
