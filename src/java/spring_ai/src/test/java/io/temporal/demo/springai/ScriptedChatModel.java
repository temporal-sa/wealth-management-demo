package io.temporal.demo.springai;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import org.springframework.ai.chat.messages.AssistantMessage;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.chat.model.ChatResponse;
import org.springframework.ai.chat.model.Generation;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.model.tool.ToolCallingChatOptions;

/**
 * A chat model for tests that replays a script instead of calling Gemini. The worker's Spring AI plugin gets it
 * in place of Gemini, so the integration's chat model activity calls it. Each step is a tool call (a handoff is
 * one too) or a message to the customer. A tool the active agent doesn't offer fails the test.
 * {@code SYSTEM_PROMPTS} records the system prompt of every call.
 */
public class ScriptedChatModel implements ChatModel {
    public static final List<Object[]> SCRIPT = new CopyOnWriteArrayList<>();
    public static final List<String> SYSTEM_PROMPTS = new CopyOnWriteArrayList<>();

    public static Object[] tool(String name, String argumentsJson) {
        return new Object[] {"tool", name, argumentsJson};
    }

    public static Object[] handoff(String toolName) {
        return new Object[] {"tool", toolName, "{}"};
    }

    public static Object[] message(String text) {
        return new Object[] {"message", text};
    }

    @Override
    public ChatResponse call(Prompt prompt) {
        prompt.getInstructions().stream().filter(m -> m instanceof SystemMessage).findFirst()
                .ifPresent(m -> SYSTEM_PROMPTS.add(m.getText()));
        if (SCRIPT.isEmpty()) {
            throw new AssertionError("the script ran out");
        }
        Object[] step = SCRIPT.remove(0);
        if ("message".equals(step[0])) {
            return new ChatResponse(List.of(new Generation(new AssistantMessage((String) step[1]))));
        }
        List<String> offered = new ArrayList<>();
        if (prompt.getOptions() instanceof ToolCallingChatOptions options) {
            options.getToolCallbacks().forEach(t -> offered.add(t.getToolDefinition().name()));
        }
        if (!offered.isEmpty() && !offered.contains((String) step[1])) {
            throw new AssertionError("the active agent has no tool " + step[1] + ": it offers " + offered);
        }
        AssistantMessage call = AssistantMessage.builder().content("").properties(Map.of())
                .toolCalls(List.of(new AssistantMessage.ToolCall("call-" + UUID.randomUUID(), "function",
                        (String) step[1], (String) step[2]))).build();
        return new ChatResponse(List.of(new Generation(call)));
    }
}
