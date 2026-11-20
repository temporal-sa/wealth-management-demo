package io.temporal.demo.springai;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.temporal.api.enums.v1.EventType;
import io.temporal.api.enums.v1.WorkflowExecutionStatus;
import io.temporal.api.workflowservice.v1.DescribeWorkflowExecutionRequest;
import io.temporal.client.WorkflowClient;
import io.temporal.client.WorkflowOptions;
import io.temporal.demo.springai.model.InvestmentAccount;
import io.temporal.demo.springai.model.InvestmentRecord;
import io.temporal.demo.springai.model.OpenInvestmentAccountInput;
import io.temporal.demo.springai.model.OpenInvestmentAccountOutput;
import io.temporal.demo.springai.model.Transfer;
import io.temporal.demo.springai.model.WealthManagementClient;
import io.temporal.demo.springai.workflows.OpenInvestmentAccountWorkflow;
import io.temporal.demo.springai.workflows.OpenInvestmentAccountWorkflowImpl;
import io.temporal.failure.ApplicationFailure;
import io.temporal.testing.TestWorkflowEnvironment;
import io.temporal.worker.Worker;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** The account opening's saga and its failure scenarios, with stub activities. */
class OpenAccountWorkflowTest {
    static final String QUEUE = "test-open-account";

    private TestWorkflowEnvironment env;
    private WorkflowClient client;
    private final List<String> calls = new CopyOnWriteArrayList<>();
    private volatile boolean custodianRejects;

    private final StubActivities activities = new StubActivities() {
        @Override
        public WealthManagementClient getClient(String clientId) {
            return new WealthManagementClient("Sam", "Doe", "1 Main St", "555", "s@example.com", "single");
        }

        @Override
        public InvestmentRecord openInvestment(InvestmentAccount account) {
            calls.add("open_investment:" + account.balance());
            return new InvestmentRecord("i-test", account.name(), account.balance());
        }

        @Override
        public boolean removeInvestment(String clientId, String investmentId) {
            calls.add("remove_investment:" + investmentId);
            return true;
        }

        @Override
        public Transfer debitLinkedAccount(String clientId, double amount, String transferId) {
            calls.add("debit:" + amount);
            return new Transfer(clientId, -amount, 0);
        }

        @Override
        public Transfer creditLinkedAccount(String clientId, double amount, String transferId) {
            assertTrue(transferId.endsWith("-refund"));
            calls.add("credit:" + amount);
            return new Transfer(clientId, amount, 0);
        }

        @Override
        public String registerAccount(String clientId, String investmentId, double amount) {
            calls.add("register");
            if (custodianRejects) {
                throw ApplicationFailure.newNonRetryableFailure("The custodian rejected the account registration",
                        "CustodianRejected");
            }
            return "CUST-" + investmentId;
        }
    };

    @BeforeEach
    void setUp() {
        env = TestWorkflowEnvironment.newInstance();
        Worker worker = env.newWorker(QUEUE);
        worker.registerWorkflowImplementationTypes(OpenInvestmentAccountWorkflowImpl.class);
        worker.registerActivitiesImplementations(activities);
        env.start();
        client = env.getWorkflowClient();
    }

    @AfterEach
    void tearDown() {
        env.close();
    }

    private OpenInvestmentAccountWorkflow startAndApprove(String id, String promoCode) {
        OpenInvestmentAccountWorkflow wf = client.newWorkflowStub(OpenInvestmentAccountWorkflow.class,
                WorkflowOptions.newBuilder().setTaskQueue(QUEUE).setWorkflowId(id).build());
        WorkflowClient.start(wf::run, new OpenInvestmentAccountInput("123", "Test", 500.0, promoCode));
        wf.verifyKyc();
        wf.complianceApproved();
        return wf;
    }

    @Test
    void theSagaCreatesFundsAndRegistersTheAccount() {
        String id = "open-" + UUID.randomUUID();
        startAndApprove(id, null);
        OpenInvestmentAccountOutput result = client.newUntypedWorkflowStub(id).getResult(OpenInvestmentAccountOutput.class);
        assertTrue(result.accountCreated());
        assertEquals(List.of("open_investment:500.0", "debit:500.0", "register"), calls);
    }

    @Test
    void aCustodianRejectionRollsBackInReverse() {
        custodianRejects = true;
        String id = "open-" + UUID.randomUUID();
        OpenInvestmentAccountWorkflow wf = startAndApprove(id, null);
        OpenInvestmentAccountOutput result = client.newUntypedWorkflowStub(id).getResult(OpenInvestmentAccountOutput.class);
        assertFalse(result.accountCreated());
        assertEquals("The account was not opened: The custodian rejected the account registration", result.message());
        assertEquals(List.of("open_investment:500.0", "debit:500.0", "register", "credit:500.0",
                "remove_investment:i-test"), calls);
        assertTrue(wf.getCurrentState().startsWith("Rolled back."));
    }

    @Test
    void theWelcomeBonusBugPausesTheWorkflowInsteadOfFailingIt() throws InterruptedException {
        String id = "open-" + UUID.randomUUID();
        startAndApprove(id, "WELCOME-BONUS");
        boolean taskFailed = false;
        for (int i = 0; i < 100 && !taskFailed; i++) {
            Thread.sleep(100);
            taskFailed = client.fetchHistory(id).getEvents().stream()
                    .anyMatch(e -> e.getEventType() == EventType.EVENT_TYPE_WORKFLOW_TASK_FAILED);
        }
        assertTrue(taskFailed, "the bug should fail a workflow task");
        WorkflowExecutionStatus status = env.getWorkflowServiceStubs().blockingStub().describeWorkflowExecution(
                DescribeWorkflowExecutionRequest.newBuilder().setNamespace(env.getNamespace())
                        .setExecution(io.temporal.api.common.v1.WorkflowExecution.newBuilder().setWorkflowId(id))
                        .build()).getWorkflowExecutionInfo().getStatus();
        assertEquals(WorkflowExecutionStatus.WORKFLOW_EXECUTION_STATUS_RUNNING, status);
        assertTrue(calls.isEmpty(), "no saga step runs before the bonus is computed");
    }
}
