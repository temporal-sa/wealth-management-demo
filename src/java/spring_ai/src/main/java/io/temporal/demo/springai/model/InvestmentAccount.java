package io.temporal.demo.springai.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * The argument of the open_investment activity.
 * The JSON names are part of the shared Temporal contract, so they stay snake_case.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record InvestmentAccount(
        @JsonProperty("client_id") String clientId,
        @JsonProperty("name") String name,
        @JsonProperty("balance") double balance) {
}
