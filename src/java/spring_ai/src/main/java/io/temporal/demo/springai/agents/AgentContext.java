package io.temporal.demo.springai.agents;

import java.util.ArrayList;
import java.util.List;

/** State shared by all the agents in a conversation, kept outside the messages. */
public class AgentContext {
    /**
     * The customer's client ID, once a tool has been called with it, so that every agent is told it and none
     * asks for it again.
     */
    public String clientId;

    /** Facts every agent is told at the end of its instructions, on every model call. */
    public List<String> promptNotes() {
        List<String> notes = new ArrayList<>();
        if (clientId != null) {
            notes.add("The customer's client ID is " + clientId + ". Use it, and don't ask for it again.");
        }
        return notes;
    }
}
