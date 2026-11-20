package io.temporal.demo.springai.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * A stored investment account, as list_investments and open_investment return it.
 * The JSON names are part of the shared Temporal contract, so they stay snake_case.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record InvestmentRecord(
        @JsonProperty("investment_id") String investmentId,
        @JsonProperty("name") String name,
        @JsonProperty("balance") double balance) {
}
