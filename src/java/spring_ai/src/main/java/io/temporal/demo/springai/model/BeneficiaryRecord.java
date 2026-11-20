package io.temporal.demo.springai.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * A stored beneficiary, as list_beneficiaries returns it.
 * The JSON names are part of the shared Temporal contract, so they stay snake_case.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record BeneficiaryRecord(
        @JsonProperty("beneficiary_id") String beneficiaryId,
        @JsonProperty("first_name") String firstName,
        @JsonProperty("last_name") String lastName,
        @JsonProperty("relationship") String relationship) {
}
