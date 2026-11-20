package io.temporal.demo.springai.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * The input of OpenInvestmentAccountWorkflow. promoCode is set while a promotion runs (WELCOME-BONUS).
 * The JSON names are part of the shared Temporal contract, so they stay snake_case.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record OpenInvestmentAccountInput(
        @JsonProperty("client_id") String clientId,
        @JsonProperty("account_name") String accountName,
        @JsonProperty("initial_amount") double initialAmount,
        @JsonProperty("promo_code") String promoCode) {
}
