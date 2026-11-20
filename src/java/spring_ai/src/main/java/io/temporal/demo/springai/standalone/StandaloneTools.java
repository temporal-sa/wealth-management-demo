package io.temporal.demo.springai.standalone;

import io.temporal.demo.springai.agents.Prompts;
import io.temporal.demo.springai.agents.TurnState;
import io.temporal.demo.springai.common.DataStore;
import io.temporal.demo.springai.common.Json;
import io.temporal.demo.springai.common.Money;
import io.temporal.demo.springai.model.Beneficiary;
import io.temporal.demo.springai.model.InvestmentAccount;
import java.util.function.Supplier;
import org.springframework.ai.tool.annotation.Tool;
import org.springframework.ai.tool.annotation.ToolParam;

/**
 * The standalone version's tools: they call the data store directly. Accounts are opened directly by one tool,
 * so there is no KYC, compliance review or saga.
 */
public final class StandaloneTools {
    static final String CLIENT_ID = "The customer's client ID";

    private final TurnState state;
    private final DataStore data;

    public StandaloneTools(TurnState state, DataStore data) {
        this.state = state;
        this.data = data;
    }

    private String run(String clientId, Supplier<Object> body) {
        state.toolCalled(clientId);
        String output;
        try {
            Object value = body.get();
            output = value == null ? "Done." : value instanceof String s ? s : Json.compact(value);
        } catch (RuntimeException e) {
            output = "Error: " + e.getMessage();
        }
        return state.output(output);
    }

    public final BeneficiaryTools beneficiaryTools = new BeneficiaryTools();
    public final InvestmentTools investmentTools = new InvestmentTools();
    public final OpenAccountTools openAccountTools = new OpenAccountTools();

    public class BeneficiaryTools {
        @Tool(name = "list_beneficiaries", description = "List the beneficiaries for the given client ID.")
        public String listBeneficiaries(@ToolParam(description = CLIENT_ID) String client_id) {
            return run(client_id, () -> data.listBeneficiaries(client_id));
        }

        @Tool(name = "add_beneficiary", description = "Add a beneficiary for the given client ID.")
        public String addBeneficiary(@ToolParam(description = CLIENT_ID) String client_id,
                @ToolParam(description = "The beneficiary's first name") String first_name,
                @ToolParam(description = "The beneficiary's last name") String last_name,
                @ToolParam(description = "The beneficiary's relationship to the customer, such as son or spouse") String relationship) {
            return run(client_id, () -> {
                data.addBeneficiary(new Beneficiary(client_id, first_name, last_name, relationship));
                return "Beneficiary " + first_name + " " + last_name + " added.";
            });
        }

        @Tool(name = "delete_beneficiary", description = "Delete a beneficiary by its beneficiary ID.")
        public String deleteBeneficiary(@ToolParam(description = CLIENT_ID) String client_id,
                @ToolParam(description = "The beneficiary ID from list_beneficiaries") String beneficiary_id) {
            return run(client_id, () -> {
                data.deleteBeneficiary(client_id, beneficiary_id);
                return "Beneficiary " + beneficiary_id + " deleted.";
            });
        }
    }

    public class InvestmentTools {
        @Tool(name = "list_investments", description = "List the investment accounts and balances for the given client ID.")
        public String listInvestments(@ToolParam(description = CLIENT_ID) String client_id) {
            return run(client_id, () -> data.listInvestments(client_id));
        }

        @Tool(name = "close_investment", description = "Close an investment account by its investment ID.")
        public String closeInvestment(@ToolParam(description = CLIENT_ID) String client_id,
                @ToolParam(description = "The investment ID from list_investments") String investment_id) {
            return run(client_id, () -> {
                // A real close would be much more involved, and would not delete the account record
                data.deleteInvestment(client_id, investment_id);
                return "Investment account " + investment_id + " closed.";
            });
        }
    }

    public class OpenAccountTools {
        @Tool(name = "open_new_investment_account",
                description = "Open a new investment account. Returns the new account, or the reason it cannot be opened.")
        public String openNewInvestmentAccount(@ToolParam(description = CLIENT_ID) String client_id,
                @ToolParam(description = "The name for the new investment account") String account_name,
                @ToolParam(description = "The initial deposit amount") double initial_amount) {
            return run(client_id, () -> {
                if (initial_amount < Prompts.MIN_INITIAL_DEPOSIT) {
                    return "The account cannot be opened: the initial deposit must be at least "
                            + Money.format(Prompts.MIN_INITIAL_DEPOSIT);
                }
                if (initial_amount > Prompts.MAX_INITIAL_DEPOSIT) {
                    return "The account cannot be opened: initial deposits over " + Money.format(Prompts.MAX_INITIAL_DEPOSIT)
                            + " cannot be opened online and must be arranged with a wealth advisor";
                }
                return data.addInvestment(new InvestmentAccount(client_id, account_name, initial_amount));
            });
        }
    }
}
