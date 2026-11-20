package io.temporal.demo.springai.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * A customer's details, shown to them for KYC.
 * The JSON names are part of the shared Temporal contract, so they stay snake_case.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record WealthManagementClient(
        @JsonProperty("first_name") String firstName,
        @JsonProperty("last_name") String lastName,
        @JsonProperty("address") String address,
        @JsonProperty("phone") String phone,
        @JsonProperty("email") String email,
        @JsonProperty("marital_status") String maritalStatus) {
}
