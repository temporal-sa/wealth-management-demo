package io.temporal.demo.springai.agents;

import org.springframework.ai.tool.annotation.Tool;

/**
 * The handoff tools, one class per target agent, so each agent gets exactly the handoffs it may make.
 *
 * <p>Each is {@code returnDirect}: when the model calls it, Spring AI ends the agent's tool loop and returns,
 * without another model call. The turn loop ({@link Conversation}) then gives the same customer message to the
 * agent handed off to, so it answers in the same reply.
 */
public final class Handoffs {
    private Handoffs() {
    }

    public record ToSupervisor(TurnState state) {
        @Tool(name = "transfer_to_supervisor_agent", returnDirect = true,
                description = "Handoff to the " + Prompts.SUPERVISOR_AGENT + ". " + Prompts.SUPERVISOR_HANDOFF)
        public String transferToSupervisorAgent() {
            return state.handoff(Prompts.SUPERVISOR_AGENT);
        }
    }

    public record ToBeneficiary(TurnState state) {
        @Tool(name = "transfer_to_beneficiary_agent", returnDirect = true,
                description = "Handoff to the " + Prompts.BENEFICIARY_AGENT + ". " + Prompts.BENEFICIARY_HANDOFF)
        public String transferToBeneficiaryAgent() {
            return state.handoff(Prompts.BENEFICIARY_AGENT);
        }
    }

    public record ToInvestment(TurnState state) {
        @Tool(name = "transfer_to_investment_agent", returnDirect = true,
                description = "Handoff to the " + Prompts.INVESTMENT_AGENT + ". " + Prompts.INVESTMENT_HANDOFF)
        public String transferToInvestmentAgent() {
            return state.handoff(Prompts.INVESTMENT_AGENT);
        }
    }

    public record ToOpenAccount(TurnState state) {
        @Tool(name = "transfer_to_open_account_agent", returnDirect = true,
                description = "Handoff to the " + Prompts.OPEN_ACCOUNT_AGENT + ". " + Prompts.OPEN_ACCOUNT_HANDOFF)
        public String transferToOpenAccountAgent() {
            return state.handoff(Prompts.OPEN_ACCOUNT_AGENT);
        }
    }
}
