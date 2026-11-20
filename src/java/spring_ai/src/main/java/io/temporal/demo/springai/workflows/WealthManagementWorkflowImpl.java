package io.temporal.demo.springai.workflows;

import io.temporal.activity.ActivityOptions;
import io.temporal.activity.LocalActivityOptions;
import io.temporal.demo.springai.activities.WealthActivities;
import io.temporal.demo.springai.agents.Conversation;
import io.temporal.demo.springai.agents.Prompts;
import io.temporal.demo.springai.agents.TurnState;
import io.temporal.demo.springai.common.RetryPolicies;
import io.temporal.demo.springai.common.TaskQueues;
import io.temporal.demo.springai.model.ChatInteraction;
import io.temporal.demo.springai.model.ProcessUserMessageInput;
import io.temporal.demo.springai.model.StatusUpdate;
import io.temporal.demo.springai.model.UpdateAccountOpeningStateInput;
import io.temporal.springai.chat.TemporalChatClient;
import io.temporal.springai.model.ActivityChatModel;
import io.temporal.workflow.Workflow;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import org.slf4j.Logger;
import org.springframework.ai.chat.messages.Message;
import org.springframework.ai.chat.messages.UserMessage;

/**
 * The chat workflow: one long-lived workflow per conversation, running the four Spring AI agents.
 *
 * <p>Every model call is an activity: the agents' chat model is Temporal's {@link ActivityChatModel}, which runs
 * each call as the integration's chat model activity on the model task queue, so a model outage pauses the turn
 * instead of losing it. The tools run here, in the workflow ({@link ChatTools}), and the ones that touch a
 * system run activities. The conversation (messages, active agent, client ID, account openings) is workflow
 * state, so it is deterministic and survives replay.
 */
public class WealthManagementWorkflowImpl implements WealthManagementWorkflow {
    /** A chat with no customer message and no account-opening update for this long ends by itself. */
    static final Duration CHAT_IDLE_TIMEOUT = Duration.ofHours(1);
    /** One attempt of a model call. Retries are unlimited (RetryPolicies.LLM). */
    static final Duration MODEL_TIMEOUT = Duration.ofSeconds(60);

    private final Logger log = Workflow.getLogger(WealthManagementWorkflowImpl.class);
    // Publishing to the UI's event stream (Redis), retried until Redis is reachable
    private final WealthActivities events = Workflow.newLocalActivityStub(WealthActivities.class,
            LocalActivityOptions.newBuilder().setStartToCloseTimeout(Duration.ofSeconds(5))
                    .setRetryOptions(RetryPolicies.TOOL).build());

    private final WealthManagementContext context = new WealthManagementContext();
    private final TurnState state = new TurnState(context);
    // The conversation: the customer's messages and the agents' replies
    private final List<Message> history = new ArrayList<>();
    private final List<ChatInteraction> chatHistory = new ArrayList<>();
    private final List<String> pendingMessages = new ArrayList<>();
    private final List<String> pendingStatusUpdates = new ArrayList<>();
    private String currentAgent = Prompts.SUPERVISOR_AGENT;
    private boolean ending;

    /** The agents. Their chat model runs every call as an activity on the model task queue. */
    static Conversation agents(TurnState state, WealthManagementContext context) {
        ActivityChatModel model = ActivityChatModel.forDefault(ActivityOptions.newBuilder()
                .setTaskQueue(TaskQueues.llm())
                .setStartToCloseTimeout(MODEL_TIMEOUT)
                .setRetryOptions(RetryPolicies.LLM)
                .build());
        ChatTools tools = new ChatTools(state, context, TaskQueues.openAccount());
        return new Conversation(model, TemporalChatClient::builder, state,
                new Conversation.AgentTools(tools.beneficiaryTools, tools.investmentTools, tools.openAccountTools),
                Prompts.OPEN_ACCOUNT_INSTRUCTIONS);
    }

    @Override
    public void run() {
        String workflowId = Workflow.getInfo().getWorkflowId();
        // Delete any earlier conversation stored under this ID: the demo UI reuses chat IDs
        events.deleteConversation(workflowId);
        Conversation agents = agents(state, context);

        while (true) {
            boolean woken = Workflow.await(CHAT_IDLE_TIMEOUT,
                    () -> !pendingMessages.isEmpty() || !pendingStatusUpdates.isEmpty() || ending);
            if (!woken) {
                log.info("Ending chat: idle for {}", CHAT_IDLE_TIMEOUT);
                return;
            }
            if (ending) {
                log.info("Ending workflow.");
                return;
            }
            // One customer message, then one status update, at a time
            if (!pendingMessages.isEmpty()) {
                processMessage(agents, workflowId, pendingMessages.remove(0));
            }
            if (!pendingStatusUpdates.isEmpty()) {
                events.appendStatusUpdate(workflowId, new StatusUpdate(pendingStatusUpdates.remove(0)));
            }
            // TODO: Continue-As-New. This demo keeps the whole conversation in one run. A production system would
            // continue-as-new when Workflow.getInfo().isContinueAsNewSuggested(), carrying the messages, the active
            // agent and the context, and minding that the open-account children use PARENT_CLOSE_POLICY_TERMINATE.
        }
    }

    private void processMessage(Conversation agents, String workflowId, String message) {
        log.info("Processing chat message: {}", message);
        context.turn++;
        history.add(new UserMessage(message));
        Conversation.TurnResult result = agents.runTurn(history, currentAgent);
        currentAgent = result.agent();

        ChatInteraction interaction = new ChatInteraction(message, result.text(),
                lines(state.toolOutputs), lines(state.trace));
        chatHistory.add(interaction);
        Workflow.setCurrentDetails("**Active agent:** " + currentAgent + "\n\n**Customer:** " + message
                + "\n\n**Reply:** " + result.text());
        events.appendChatInteraction(workflowId, interaction);
    }

    private static String lines(List<String> items) {
        StringBuilder out = new StringBuilder();
        items.forEach(line -> out.append(line).append("\n"));
        return out.toString();
    }

    @Override
    public void processUserMessage(ProcessUserMessageInput input) {
        log.info("Received user message {}", input);
        pendingMessages.add(input.userInput());
    }

    @Override
    public void updateAccountOpeningState(UpdateAccountOpeningStateInput input) {
        log.info("Account opening state changed: {} {}", input.accountName(), input.state());
        if (input.workflowId() != null) {
            context.accountOpeningStates.put(input.workflowId(), input.state());
        }
        pendingStatusUpdates.add("New " + input.accountName() + " account status changed: " + input.state());
    }

    @Override
    public void endWorkflow() {
        ending = true;
    }

    @Override
    public List<ChatInteraction> getChatHistory() {
        return chatHistory;
    }
}
