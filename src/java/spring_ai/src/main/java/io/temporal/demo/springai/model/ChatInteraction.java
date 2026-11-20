package io.temporal.demo.springai.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * One turn of the conversation: the customer's message and the agents' reply. The get_chat_history query
 * returns these, and each is appended to the Redis event stream.
 * The JSON names are part of the shared Temporal contract, so they stay snake_case.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record ChatInteraction(
        @JsonProperty("user_prompt") String userPrompt,
        @JsonProperty("text_response") String textResponse,
        @JsonProperty("json_response") String jsonResponse,
        @JsonProperty("agent_trace") String agentTrace) {
}
