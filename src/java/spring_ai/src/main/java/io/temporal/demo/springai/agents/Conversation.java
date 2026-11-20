package io.temporal.demo.springai.agents;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.messages.AssistantMessage;
import org.springframework.ai.chat.messages.Message;
import org.springframework.ai.chat.model.ChatModel;

/**
 * The four agents and the turn loop, shared by the standalone and Temporal versions.
 *
 * <pre>
 *   Supervisor Agent   -&gt; Beneficiary Agent, Investment Agent
 *   Beneficiary Agent  -&gt; Supervisor Agent
 *   Investment Agent   -&gt; Open Account Agent, Supervisor Agent
 *   Open Account Agent -&gt; Investment Agent
 * </pre>
 *
 * <p>Each agent is a Spring AI {@link ChatClient} with its own tools, which include its handoffs. One customer
 * message is one {@link #runTurn}: the active agent's client runs (Spring AI calls the model and runs the
 * tools it asks for, until the model answers); if the agent handed off, the agent handed off to gets the same
 * message, and so on. Each version supplies the chat model and the tools: the standalone version calls Gemini
 * and the data files directly, the Temporal version runs every model call and tool as an activity.
 */
public class Conversation {
    /** Handoffs allowed in one customer message, so agents that keep handing off can't loop forever. */
    public static final int MAX_HANDOFFS = 5;
    public static final String GIVE_UP = "Sorry, I wasn't able to finish that request. Could you try again?";
    public static final String EMPTY_REPLY = "Sorry, I don't have a response to that. Could you rephrase it?";

    private final Map<String, String> instructions = new LinkedHashMap<>();
    private final Map<String, ChatClient> clients = new LinkedHashMap<>();
    private final TurnState state;

    /** The tools of each agent, apart from its handoffs. */
    public record AgentTools(Object beneficiary, Object investment, Object openAccount) {
    }

    /**
     * @param newClient   builds a ChatClient for a chat model (the Temporal version's TemporalChatClient.builder)
     * @param openAccountInstructions the Open Account Agent's routine, which differs by version
     */
    public Conversation(ChatModel model, Function<ChatModel, ChatClient.Builder> newClient, TurnState state,
            AgentTools tools, String openAccountInstructions) {
        this.state = state;
        add(model, newClient, Prompts.SUPERVISOR_AGENT, Prompts.SUPERVISOR_INSTRUCTIONS,
                new Handoffs.ToBeneficiary(state), new Handoffs.ToInvestment(state));
        add(model, newClient, Prompts.BENEFICIARY_AGENT, Prompts.BENEFICIARY_INSTRUCTIONS,
                tools.beneficiary(), new Handoffs.ToSupervisor(state));
        add(model, newClient, Prompts.INVESTMENT_AGENT, Prompts.INVESTMENT_INSTRUCTIONS,
                tools.investment(), new Handoffs.ToOpenAccount(state), new Handoffs.ToSupervisor(state));
        add(model, newClient, Prompts.OPEN_ACCOUNT_AGENT, openAccountInstructions,
                tools.openAccount(), new Handoffs.ToInvestment(state));
    }

    private void add(ChatModel model, Function<ChatModel, ChatClient.Builder> newClient, String name,
            String agentInstructions, Object... tools) {
        instructions.put(name, agentInstructions);
        clients.put(name, newClient.apply(model).defaultTools(tools).build());
    }

    /** The agent's instructions, plus the conversation's notes, such as the client ID once it is known. */
    public String systemPrompt(String agent) {
        StringBuilder prompt = new StringBuilder(instructions.get(agent));
        for (String note : state.context.promptNotes()) {
            prompt.append("\n    ").append(note);
        }
        return prompt.toString();
    }

    /** What one customer message produced: the reply, and the agent that takes the next message. */
    public record TurnResult(String text, String agent) {
    }

    /**
     * Runs one customer message, already appended to {@code history}, starting with {@code agent}. Appends the
     * reply to {@code history}. The conversation keeps the customer's messages and the agents' replies; tool
     * calls stay inside each turn, and what the agents must know later (the client ID, the account openings) is
     * in their notes.
     */
    public TurnResult runTurn(List<Message> history, String agent) {
        state.reset(agent);
        for (int handoffs = 0; handoffs <= MAX_HANDOFFS; handoffs++) {
            state.activeAgent = agent;
            state.nextAgent = null;
            String content = clients.get(agent).prompt().system(systemPrompt(agent)).messages(history).call().content();
            if (state.nextAgent != null) {
                // Handed off: the next agent answers the same message
                agent = state.nextAgent;
                continue;
            }
            String text = content == null || content.isBlank() ? EMPTY_REPLY : content;
            history.add(new AssistantMessage(text));
            return new TurnResult(text, agent);
        }
        history.add(new AssistantMessage(GIVE_UP));
        return new TurnResult(GIVE_UP, agent);
    }
}
