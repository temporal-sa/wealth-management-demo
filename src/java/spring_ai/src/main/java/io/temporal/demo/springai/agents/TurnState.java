package io.temporal.demo.springai.agents;

import java.util.ArrayList;
import java.util.List;

/**
 * What the tools record during one customer message: the agent that is answering, the handoff it asked for,
 * and the trace and tool outputs the chat history shows. The tools of every agent share one TurnState.
 */
public class TurnState {
    public final AgentContext context;
    public String activeAgent;
    public String nextAgent;
    public final List<String> trace = new ArrayList<>();
    public final List<String> toolOutputs = new ArrayList<>();

    public TurnState(AgentContext context) {
        this.context = context;
    }

    /** Starts a new customer message. */
    public void reset(String agent) {
        activeAgent = agent;
        nextAgent = null;
        trace.clear();
        toolOutputs.clear();
    }

    /** Called by every tool as it starts: traces the call and remembers the client ID if it has one. */
    public void toolCalled(String clientId) {
        trace.add(activeAgent + ": Calling a tool");
        if (clientId != null && !clientId.isBlank()) {
            context.clientId = clientId;
        }
    }

    /** Called by every tool with its result, which the chat history's json_response shows. */
    public String output(String output) {
        toolOutputs.add(output);
        return output;
    }

    /** Called by a handoff tool. Only the first handoff in a model reply counts. */
    public String handoff(String target) {
        if (nextAgent != null) {
            return "Ignored: the conversation was already handed off to the " + nextAgent + ".";
        }
        nextAgent = target;
        trace.add("Handed off from " + activeAgent + " to " + target);
        return "Transferred to the " + target + ". The " + target + " answers the customer now.";
    }
}
