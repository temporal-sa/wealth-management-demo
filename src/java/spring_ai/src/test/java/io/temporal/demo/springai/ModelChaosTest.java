package io.temporal.demo.springai;

import static io.temporal.demo.springai.ScriptedChatModel.message;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.temporal.activity.ActivityInfo;
import io.temporal.api.workflow.v1.PendingActivityInfo;
import io.temporal.api.workflowservice.v1.DescribeWorkflowExecutionRequest;
import io.temporal.client.WorkflowClient;
import io.temporal.client.WorkflowOptions;
import io.temporal.demo.springai.common.Chaos;
import io.temporal.demo.springai.common.Session;
import io.temporal.demo.springai.common.TaskQueues;
import io.temporal.demo.springai.model.ChatInteraction;
import io.temporal.demo.springai.model.ProcessUserMessageInput;
import io.temporal.demo.springai.workflows.WealthManagementWorkflow;
import io.temporal.demo.springai.workflows.WealthManagementWorkflowImpl;
import io.temporal.demo.springai.worker.ModelCallInterceptor;
import io.temporal.springai.plugin.SpringAiPlugin;
import io.temporal.testing.TestEnvironmentOptions;
import io.temporal.testing.TestWorkflowEnvironment;
import io.temporal.worker.Worker;
import io.temporal.worker.WorkerFactoryOptions;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/**
 * The chaos panel's model switches, through the real worker setup: the Spring AI plugin and the model call
 * interceptor. While a switch is on, the chat model activity fails and is retried, and the turn waits; once it
 * is off, the turn carries on. The flags are a browser session's, as in Redis: the chat's workflow ID carries the
 * session, and the interceptor must find it from the activity it wraps.
 */
class ModelChaosTest {
    static final String SESSION = "0123456789abcdef0123456789abcdef";

    private TestWorkflowEnvironment env;
    private final Set<String> flags = ConcurrentHashMap.newKeySet();

    /** Flags looked up by session, like Chaos.Redis: on only for SESSION. */
    class SessionFlags implements Chaos {
        private final ActivityInfo activity;

        SessionFlags(ActivityInfo activity) {
            this.activity = activity;
        }

        @Override
        public Chaos forActivity(ActivityInfo info) {
            return new SessionFlags(info);
        }

        @Override
        public boolean isEnabled(String flag) {
            String session = activity != null ? Session.fromWorkflowId(activity.getWorkflowId()) : Session.current();
            return SESSION.equals(session) && flags.contains(flag);
        }

        @Override
        public void recordEvent(String flag) {
        }
    }

    @AfterEach
    void tearDown() {
        env.close();
    }

    private PendingActivityInfo pendingModelCall(String id) throws InterruptedException {
        for (int i = 0; i < 100; i++) {
            List<PendingActivityInfo> pending = env.getWorkflowServiceStubs().blockingStub().describeWorkflowExecution(
                    DescribeWorkflowExecutionRequest.newBuilder().setNamespace(env.getNamespace())
                            .setExecution(io.temporal.api.common.v1.WorkflowExecution.newBuilder().setWorkflowId(id))
                            .build()).getPendingActivitiesList();
            if (!pending.isEmpty() && pending.get(0).getAttempt() >= 2) {
                return pending.get(0);
            }
            Thread.sleep(100);
        }
        throw new AssertionError("the model call was never retried");
    }

    private void check(String flag, String expectedFailureType) throws Exception {
        ScriptedChatModel.SCRIPT.clear();
        flags.add(flag);
        env = TestWorkflowEnvironment.newInstance(TestEnvironmentOptions.newBuilder().setUseTimeskipping(false)
                .setWorkerFactoryOptions(WorkerFactoryOptions.newBuilder()
                        .setPlugins(new SpringAiPlugin(new ScriptedChatModel()))
                        .setWorkerInterceptors(new ModelCallInterceptor(new SessionFlags(null))).build())
                .build());
        Worker worker = env.newWorker(TaskQueues.chat());
        worker.registerWorkflowImplementationTypes(WealthManagementWorkflowImpl.class);
        worker.registerActivitiesImplementations(new StubActivities());
        env.newWorker(TaskQueues.llm());
        env.start();
        WorkflowClient client = env.getWorkflowClient();

        String id = "springai-temporal-agent-session-" + SESSION + "-chat-" + UUID.randomUUID().toString().substring(0, 8);
        WealthManagementWorkflow chat = client.newWorkflowStub(WealthManagementWorkflow.class,
                WorkflowOptions.newBuilder().setTaskQueue(TaskQueues.chat()).setWorkflowId(id).build());
        WorkflowClient.start(chat::run);
        ScriptedChatModel.SCRIPT.add(message("Hello! What is your client ID?"));
        chat.processUserMessage(new ProcessUserMessageInput("Hi"));

        PendingActivityInfo pending = pendingModelCall(id);
        assertEquals("CallChatModel", pending.getActivityType().getName());
        assertTrue(pending.getLastFailure().getApplicationFailureInfo().getType().contains(expectedFailureType),
                pending.getLastFailure().toString());
        assertTrue(chat.getChatHistory().isEmpty(), "the turn waits while the model is down");

        flags.clear();
        // A rate-limited call is retried 15 s later, overriding the backoff
        for (int i = 0; i < 300 && chat.getChatHistory().isEmpty(); i++) {
            Thread.sleep(100);
        }
        List<ChatInteraction> history = chat.getChatHistory();
        assertEquals("Hello! What is your client ID?", history.get(0).textResponse());
        chat.endWorkflow();
    }

    @Test
    void whileTheModelApiIsDownTheTurnWaitsAndCarriesOn() throws Exception {
        check(Chaos.LLM_DOWN, "IllegalStateException");
    }

    @Test
    void whileTheModelIsRateLimitedTheCallIsRetriedAfterTheDelay() throws Exception {
        check(Chaos.LLM_RATE_LIMITED, "ModelRateLimited");
    }
}
