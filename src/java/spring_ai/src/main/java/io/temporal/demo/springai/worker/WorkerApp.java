package io.temporal.demo.springai.worker;

import io.temporal.client.WorkflowClient;
import io.temporal.demo.springai.activities.WealthActivitiesImpl;
import io.temporal.demo.springai.claimcheck.ClaimCheckCodec;
import io.temporal.demo.springai.common.Chaos;
import io.temporal.demo.springai.common.DataStore;
import io.temporal.demo.springai.common.EventStream;
import io.temporal.demo.springai.common.TaskQueues;
import io.temporal.demo.springai.common.WorkerInfo;
import io.temporal.demo.springai.workflows.OpenInvestmentAccountWorkflowImpl;
import io.temporal.demo.springai.workflows.WealthManagementWorkflowImpl;
import io.temporal.springai.plugin.SpringAiPlugin;
import io.temporal.worker.Worker;
import io.temporal.worker.WorkerFactory;
import io.temporal.worker.WorkerFactoryOptions;
import io.temporal.worker.WorkerOptions;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.CommandLineRunner;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.data.redis.core.StringRedisTemplate;

/**
 * The worker: the chat and open-account workflows, their activities, and the model calls.
 *
 * <p>Temporal's Spring AI plugin is given the chat model (Gemini) and registers its
 * chat model activity on the workers. Two workers share one client:
 * <ul>
 *   <li>the chat task queue (TEMPORAL_TASK_QUEUE, default SpringAI-Supervisor) runs the workflows and the
 *   tool activities;</li>
 *   <li>the model task queue (&lt;TEMPORAL_TASK_QUEUE&gt;-llm, or TEMPORAL_TASK_QUEUE_LLM) runs the model calls.
 *   LLM_MAX_CALLS_PER_SECOND has the Temporal service rate limit them across all workers.</li>
 * </ul>
 * If TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT names another queue (java: the Java worker's), the open-account workflow
 * is left to the worker polling it.
 */
@SpringBootApplication(scanBasePackages = "io.temporal.demo.springai.claimcheck",
        excludeName = "io.temporal.springai.autoconfigure.SpringAiTemporalAutoConfiguration")
public class WorkerApp implements CommandLineRunner {
    private static final Logger log = LoggerFactory.getLogger(WorkerApp.class);

    private final ChatModel gemini;
    private final StringRedisTemplate redis;
    private final ObjectProvider<ClaimCheckCodec> claimCheckCodec;

    public WorkerApp(ChatModel gemini, StringRedisTemplate redis, ObjectProvider<ClaimCheckCodec> claimCheckCodec) {
        this.gemini = gemini;
        this.redis = redis;
        this.claimCheckCodec = claimCheckCodec;
    }

    /** The Gemini model the agents use: GEMINI_MODEL, or the same default as the other Gemini frameworks. */
    static String geminiModel() {
        return Connection.env("GEMINI_MODEL", "gemini-3.8-flash");
    }

    public static void main(String[] args) {
        SpringApplication.run(WorkerApp.class, args);
    }

    @Override
    public void run(String... args) {
        WorkflowClient client = Connection.connect(Connection.useClaimCheck() ? claimCheckCodec.getObject() : null);
        Chaos chaos = new Chaos.Redis(redis);
        DataStore data = new DataStore(DataStore.findDataDir(), DataStore.useRedis() ? redis : null);

        WorkerFactory factory = WorkerFactory.newInstance(client, WorkerFactoryOptions.newBuilder()
                .setPlugins(new SpringAiPlugin(gemini))
                .setWorkerInterceptors(new ModelCallInterceptor(chaos)).build());

        String chatQueue = TaskQueues.chat();
        // For the web UI's sidebar
        WorkerInfo.publishModel(redis, chatQueue, geminiModel());
        Worker worker = factory.newWorker(chatQueue);
        worker.registerWorkflowImplementationTypes(WealthManagementWorkflowImpl.class);
        if (TaskQueues.openAccount().equals(chatQueue)) {
            worker.registerWorkflowImplementationTypes(OpenInvestmentAccountWorkflowImpl.class);
        } else {
            log.info("The open-account workflow runs on task queue {}: start the worker that polls it.",
                    TaskQueues.openAccount());
        }
        worker.registerActivitiesImplementations(
                new WealthActivitiesImpl(data, chaos, new EventStream.Redis(redis), client));

        String maxCalls = System.getenv("LLM_MAX_CALLS_PER_SECOND");
        WorkerOptions.Builder llmOptions = WorkerOptions.newBuilder();
        if (maxCalls != null && !maxCalls.isBlank()) {
            llmOptions.setMaxTaskQueueActivitiesPerSecond(Double.parseDouble(maxCalls));
        }
        factory.newWorker(TaskQueues.llm(), llmOptions.build());

        factory.start();
        log.info("Worker connected to {} (namespace {}, auth {}). Chat and tools on {}; model calls ({}) on {}, "
                        + "max calls per second: {}", Connection.address(), Connection.namespace(), Connection.auth(),
                chatQueue, geminiModel(), TaskQueues.llm(),
                maxCalls == null || maxCalls.isBlank() ? "unlimited" : maxCalls);
        log.info("Data: {} ({}). {}", DataStore.findDataDir(),
                DataStore.useRedis() ? "per-session copies in Redis" : "the files", Connection.claimCheckStatus());
    }
}
