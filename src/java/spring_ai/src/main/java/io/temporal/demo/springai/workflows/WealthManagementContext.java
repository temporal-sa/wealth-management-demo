package io.temporal.demo.springai.workflows;

import io.temporal.demo.springai.agents.AgentContext;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** The chat workflow's conversation state: the client ID, and the account openings started in this chat. */
public class WealthManagementContext extends AgentContext {
    /** Latest state reported by each open-account child workflow (update_account_opening_state), by workflow ID. */
    public final Map<String, String> accountOpeningStates = new LinkedHashMap<>();
    /** What each account opening is for ("Vacation with $13,500.00"), by workflow ID, oldest first. */
    public final Map<String, String> accountOpeningRequests = new LinkedHashMap<>();
    /** The number of the customer message being processed. */
    public int turn;
    /** The message in which each account opening's details were shown, by workflow ID (the KYC guard). */
    public final Map<String, Integer> kycDetailsShownTurn = new LinkedHashMap<>();
    /** Account openings started in this chat. The next opening's workflow ID ends with this number plus one. */
    public int accountOpeningsStarted;

    @Override
    public List<String> promptNotes() {
        // Every agent is told the openings' current states on every model call. The states arrive as signals,
        // not in the conversation, and an agent that doesn't know about them guesses.
        List<String> notes = super.promptNotes();
        if (!accountOpeningRequests.isEmpty()) {
            StringBuilder lines = new StringBuilder();
            accountOpeningRequests.forEach((id, request) -> lines.append("    - ").append(request)
                    .append(" (workflow ID ").append(id).append("): ")
                    .append(accountOpeningStates.getOrDefault(id, "Initializing")).append("\n"));
            notes.add("Account openings started in this conversation, oldest first, with the current status of each. "
                    + "These statuses are kept up to date for you and replace any status mentioned earlier in the "
                    + "conversation:\n" + lines
                    + "    Each opening is separate and creates at most one account. \"Complete\" means it created "
                    + "an account, which list_investments shows. A status starting with \"Rolled back\" means it "
                    + "created no account and its deposit was refunded. Any other status means it is still in "
                    + "progress. Report these statuses as they are; don't guess or apologize for them.\n"
                    + "    A new request to open an account always starts another opening, even with a name used "
                    + "before: route it to the Open Account Agent as usual, without warning about duplicates or "
                    + "asking whether the customer is sure.");
        }
        return notes;
    }
}
