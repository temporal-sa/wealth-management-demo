package io.temporal.demo.springai.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * The payload of the chat workflow's update_account_opening_state signal, which each open-account child
 * workflow sends. workflowId may be null for senders that don't set it.
 * The JSON names are part of the shared Temporal contract, so they stay snake_case.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record UpdateAccountOpeningStateInput(
        @JsonProperty("account_name") String accountName,
        @JsonProperty("state") String state,
        @JsonProperty("workflow_id") String workflowId) {
}
