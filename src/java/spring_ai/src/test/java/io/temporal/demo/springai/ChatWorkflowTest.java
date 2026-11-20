package io.temporal.demo.springai;

import static io.temporal.demo.springai.ScriptedChatModel.handoff;
import static io.temporal.demo.springai.ScriptedChatModel.message;
import static io.temporal.demo.springai.ScriptedChatModel.tool;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.temporal.api.enums.v1.EventType;
import io.temporal.api.history.v1.HistoryEvent;
import io.temporal.client.WorkflowClient;
import io.temporal.client.WorkflowOptions;
import io.temporal.demo.springai.common.Chaos;
import io.temporal.demo.springai.common.TaskQueues;
import io.temporal.demo.springai.model.ChatInteraction;
import io.temporal.demo.springai.model.InvestmentRecord;
import io.temporal.demo.springai.model.ProcessUserMessageInput;
import io.temporal.demo.springai.model.WealthManagementClient;
import io.temporal.demo.springai.workflows.WealthManagementWorkflow;
import io.temporal.demo.springai.workflows.WealthManagementWorkflowImpl;
import io.temporal.demo.springai.worker.ModelCallInterceptor;
import io.temporal.springai.plugin.SpringAiPlugin;
import io.temporal.testing.TestEnvironmentOptions;
import io.temporal.testing.TestWorkflowEnvironment;
import io.temporal.worker.Worker;
import io.temporal.worker.WorkerFactoryOptions;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * The real chat workflow, with Temporal's Spring AI plugin and a scripted chat model in place of Gemini.
 *
 * <p>Checks that every model call is the integration's chat model activity on the model task queue while the
 * tools run activities on the chat queue, that a handoff gives the same message to the next agent, and that
 * approve_kyc only approves KYC after the customer has seen and confirmed their details for that opening.
 * Uses Temporal's test server (no Gemini key, Redis or Temporal service).
 */
class ChatWorkflowTest {
    static final String CAR = "OpenAccount-test-123-Car-1";
    static final String VACATION = "OpenAccount-test-123-Vacation-2";

    private TestWorkflowEnvironment env;
    private WorkflowClient client;
    private final List<String> approved = new CopyOnWriteArrayList<>();
    private final StubActivities activities = new StubActivities() {
        @Override
        public List<InvestmentRecord> listInvestments(String clientId) {
            return List.of(new InvestmentRecord("i-1", "Checking", 1000.0));
        }

        @Override
        public WealthManagementClient getCurrentClientInfo(String workflowId) {
            return new WealthManagementClient("Sam", "Doe", "1 Main St", "555", "s@example.com", "single");
        }

        @Override
        public void approveKyc(String workflowId) {
            approved.add(workflowId);
        }
    };

    @BeforeEach
    void setUp() {
        ScriptedChatModel.SCRIPT.clear();
        ScriptedChatModel.SYSTEM_PROMPTS.clear();
        // No time skipping: the chat waits for messages with an idle timeout
        env = TestWorkflowEnvironment.newInstance(TestEnvironmentOptions.newBuilder().setUseTimeskipping(false)
                .setWorkerFactoryOptions(WorkerFactoryOptions.newBuilder()
                        .setPlugins(new SpringAiPlugin(new ScriptedChatModel()))
                        .setWorkerInterceptors(new ModelCallInterceptor(Chaos.OFF)).build())
                .build());
        Worker worker = env.newWorker(TaskQueues.chat());
        worker.registerWorkflowImplementationTypes(WealthManagementWorkflowImpl.class);
        worker.registerActivitiesImplementations(activities);
        env.newWorker(TaskQueues.llm());
        env.start();
        client = env.getWorkflowClient();
    }

    @AfterEach
    void tearDown() {
        env.close();
    }

    private WealthManagementWorkflow start(String id) {
        WealthManagementWorkflow chat = client.newWorkflowStub(WealthManagementWorkflow.class,
                WorkflowOptions.newBuilder().setTaskQueue(TaskQueues.chat()).setWorkflowId(id).build());
        WorkflowClient.start(chat::run);
        return chat;
    }

    private ChatInteraction send(WealthManagementWorkflow chat, String message) throws InterruptedException {
        int before = chat.getChatHistory().size();
        chat.processUserMessage(new ProcessUserMessageInput(message));
        for (int i = 0; i < 240; i++) {
            List<ChatInteraction> history = chat.getChatHistory();
            if (history.size() > before) {
                return history.get(history.size() - 1);
            }
            Thread.sleep(250);
        }
        throw new AssertionError("no reply to " + message);
    }

    @Test
    void aHandoffAndAToolAnswerTheSameMessageAndEveryModelCallIsAnActivityOnTheModelQueue() throws Exception {
        String id = "chat-test-" + UUID.randomUUID();
        WealthManagementWorkflow chat = start(id);
        ScriptedChatModel.SCRIPT.addAll(List.of(
                handoff("transfer_to_investment_agent"),
                tool("list_investments", "{\"client_id\":\"123\"}"),
                message("Here are your investment accounts:\n\n1. **Checking:** $1,000.00")));

        ChatInteraction reply = send(chat, "What accounts do I have? My client ID is 123.");
        assertEquals("Here are your investment accounts:\n\n1. **Checking:** $1,000.00", reply.textResponse());
        assertEquals("Handed off from Supervisor Agent to Investment Agent\nInvestment Agent: Calling a tool\n",
                reply.agentTrace());
        assertTrue(reply.jsonResponse().contains("Checking"), reply.jsonResponse());
        // The Investment Agent answered the same message
        assertTrue(ScriptedChatModel.SYSTEM_PROMPTS.get(1).contains("You are an investment agent"));
        assertEquals(activities.interactions, chat.getChatHistory());

        // The next message starts at the Investment Agent, which is now told the client ID the tool used
        ScriptedChatModel.SCRIPT.add(message("Which account?"));
        ChatInteraction next = send(chat, "Close one of them.");
        assertEquals("", next.agentTrace());
        String prompt = ScriptedChatModel.SYSTEM_PROMPTS.get(3);
        assertTrue(prompt.contains("You are an investment agent") && prompt.contains("client ID is 123"), prompt);

        chat.endWorkflow();
        client.newUntypedWorkflowStub(id).getResult(Void.class);
        List<String> scheduled = client.fetchHistory(id).getEvents().stream()
                .filter(e -> e.getEventType() == EventType.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED)
                .map(HistoryEvent::getActivityTaskScheduledEventAttributes)
                .map(a -> a.getActivityType().getName() + "@" + a.getTaskQueue().getName()).toList();
        String llm = "@" + TaskQueues.llm();
        assertEquals(List.of("CallChatModel" + llm, "CallChatModel" + llm, "list_investments@" + TaskQueues.chat(),
                "CallChatModel" + llm, "CallChatModel" + llm), scheduled);
    }

    @Test
    void kycIsApprovedOnlyAfterTheCustomerReplies() throws Exception {
        String id = "kyc-guard-test-" + UUID.randomUUID();
        WealthManagementWorkflow chat = start(id);
        ScriptedChatModel.SCRIPT.addAll(List.of(
                // The model shows the details, then approves KYC in the same turn
                handoff("transfer_to_investment_agent"), handoff("transfer_to_open_account_agent"),
                tool("get_current_client_info", "{\"workflow_id\":\"" + CAR + "\"}"),
                tool("approve_kyc", "{\"workflow_id\":\"" + CAR + "\"}"),
                message("Are these details correct?"),
                tool("approve_kyc", "{\"workflow_id\":\"" + CAR + "\"}"), message("KYC approved."),
                // The model treats the Car confirmation as approval for Vacation too
                tool("get_current_client_info", "{\"workflow_id\":\"" + VACATION + "\"}"),
                tool("approve_kyc", "{\"workflow_id\":\"" + VACATION + "\"}"),
                message("Are these details still correct?"),
                tool("approve_kyc", "{\"workflow_id\":\"" + VACATION + "\"}"), message("KYC approved.")));

        assertTrue(send(chat, "Please open an account called Car.").jsonResponse().contains("KYC was not approved"));
        assertEquals(List.of(), approved);
        assertTrue(send(chat, "Yes, that's correct.").jsonResponse().contains("KYC approved"));
        assertEquals(List.of(CAR), approved);
        assertTrue(send(chat, "Now open one called Vacation.").jsonResponse().contains("KYC was not approved"));
        assertEquals(List.of(CAR), approved);
        assertTrue(send(chat, "Yes, still correct.").jsonResponse().contains("KYC approved"));
        assertEquals(List.of(CAR, VACATION), approved);
        assertTrue(ScriptedChatModel.SCRIPT.isEmpty());
        chat.endWorkflow();
    }
}
