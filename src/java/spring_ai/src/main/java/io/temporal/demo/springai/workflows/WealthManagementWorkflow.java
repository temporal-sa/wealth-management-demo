package io.temporal.demo.springai.workflows;

import io.temporal.demo.springai.model.ChatInteraction;
import io.temporal.demo.springai.model.ProcessUserMessageInput;
import io.temporal.demo.springai.model.UpdateAccountOpeningStateInput;
import io.temporal.workflow.QueryMethod;
import io.temporal.workflow.SignalMethod;
import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;
import java.util.List;

/** The chat workflow, one per conversation. Its names are the shared Temporal contract the API relies on. */
@WorkflowInterface
public interface WealthManagementWorkflow {
    @WorkflowMethod(name = "WealthManagementWorkflow")
    void run();

    @SignalMethod(name = "process_user_message")
    void processUserMessage(ProcessUserMessageInput input);

    @SignalMethod(name = "update_account_opening_state")
    void updateAccountOpeningState(UpdateAccountOpeningStateInput input);

    @SignalMethod(name = "end_workflow")
    void endWorkflow();

    @QueryMethod(name = "get_chat_history")
    List<ChatInteraction> getChatHistory();
}
