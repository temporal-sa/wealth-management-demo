package io.temporal.demo.springai.standalone;

import io.temporal.demo.springai.agents.AgentContext;
import io.temporal.demo.springai.agents.Conversation;
import io.temporal.demo.springai.agents.Prompts;
import io.temporal.demo.springai.agents.TurnState;
import io.temporal.demo.springai.common.DataStore;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.messages.Message;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.boot.CommandLineRunner;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.data.redis.core.StringRedisTemplate;

/**
 * The standalone version: the four agents as a command-line chat, with Spring AI and no Temporal.
 *
 * <p>The same agents and turn loop as the Temporal version ({@link Conversation}), with a plain Spring AI
 * ChatClient calling Gemini and tools that call the data files directly. Accounts are opened directly, so there
 * is no KYC, compliance review or saga, and nothing survives a crash or an outage.
 */
@SpringBootApplication(excludeName = "io.temporal.springai.autoconfigure.SpringAiTemporalAutoConfiguration")
public class StandaloneApp implements CommandLineRunner {
    private final ChatModel gemini;
    private final StringRedisTemplate redis;

    public StandaloneApp(ChatModel gemini, StringRedisTemplate redis) {
        this.gemini = gemini;
        this.redis = redis;
    }

    public static void main(String[] args) {
        System.setProperty("spring.main.banner-mode", "off");
        System.setProperty("logging.level.root", "WARN");
        SpringApplication.run(StandaloneApp.class, args);
    }

    @Override
    public void run(String... args) throws Exception {
        TurnState state = new TurnState(new AgentContext());
        StandaloneTools tools = new StandaloneTools(state,
                new DataStore(DataStore.findDataDir(), DataStore.useRedis() ? redis : null));
        Conversation agents = new Conversation(gemini, ChatClient::builder, state,
                new Conversation.AgentTools(tools.beneficiaryTools, tools.investmentTools, tools.openAccountTools),
                Prompts.STANDALONE_OPEN_ACCOUNT_INSTRUCTIONS);
        List<Message> history = new ArrayList<>();
        String agent = Prompts.SUPERVISOR_AGENT;

        System.out.println("Using model " + System.getenv().getOrDefault("GEMINI_MODEL", "gemini-3.8-flash")
                + ". Type exit, end or quit to leave.");
        System.out.println("Welcome to ABC Wealth Management. How can I help you?");
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        while (true) {
            System.out.print("Enter your message: ");
            System.out.flush();
            String line = in.readLine();
            if (line == null || List.of("exit", "end", "quit").contains(line.strip().toLowerCase())) {
                break;
            }
            int turnStart = history.size();
            history.add(new UserMessage(line));
            try {
                Conversation.TurnResult result = agents.runTurn(history, agent);
                state.trace.forEach(t -> System.out.println("  [" + t + "]"));
                System.out.println(result.agent() + ": " + result.text());
                agent = result.agent();
            } catch (RuntimeException e) {
                // Without Temporal, a failed model call loses the turn: drop it and let the customer try again
                history.subList(turnStart, history.size()).clear();
                System.out.println("Error: " + e.getMessage());
            }
        }
        System.exit(0);
    }
}
