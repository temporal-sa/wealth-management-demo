package io.temporal.demo.springai.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * A movement of money to or from a client's linked bank account.
 * The JSON names are part of the shared Temporal contract, so they stay snake_case.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record Transfer(
        @JsonProperty("client_id") String clientId,
        @JsonProperty("amount") double amount,
        @JsonProperty("balance_after") double balanceAfter) {
}
