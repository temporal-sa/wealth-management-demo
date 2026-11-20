package io.temporal.demo.springai.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * The result of OpenInvestmentAccountWorkflow.
 * The JSON names are part of the shared Temporal contract, so they stay snake_case.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record OpenInvestmentAccountOutput(
        @JsonProperty("account_created") boolean accountCreated,
        @JsonProperty("message") String message) {
}
